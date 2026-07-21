'use strict';

/**
 * server.js - Hardened Node.js core HTTP server.
 *
 * A minimal, dependency-free HTTP server that preserves its original default
 * behavior (a valid `GET /` returns `200 text/plain "Hello, World!\n"`) while
 * adding production-grade reliability and robustness:
 *
 *   1. Error handling      - listen-error classification, a per-request
 *                            try/catch, req/res stream error listeners, and
 *                            process-level uncaughtException / unhandledRejection
 *                            safety nets that record a non-zero exit code.
 *   2. Graceful shutdown   - SIGTERM / SIGINT driven drain via server.close()
 *                            with an idempotency guard and a bounded, unref'd
 *                            force-exit timer that is armed BEFORE any cleanup
 *                            that could throw, so shutdown can never strand the
 *                            process.
 *   3. Input validation    - method (405), request-target (400 for malformed,
 *                            404 for unknown paths) and body-size (413) checks,
 *                            plus fail-fast validation of HOST / PORT config.
 *   4. Resource cleanup    - live-socket tracking, bounded body draining, and
 *                            deterministic connection teardown on shutdown.
 *   5. Robust processing   - request / headers / keep-alive timeouts, and
 *                            client-error handling that answers 408 for request
 *                            timeouts and 400 for parser-malformed input.
 *
 * Terminal-state ownership (concurrency safety):
 *   Every request routes all of its writes/destroys through a single guarded
 *   `finalize()` / `abandon()` pair backed by a per-request `finalized` flag.
 *   Exactly one terminal action is ever taken, so independent asynchronous
 *   events (data / end / error / close) can never each attempt their own
 *   response and trip `ERR_HTTP_HEADERS_SENT`.
 *
 * Exit-code integrity:
 *   A module-level exit code is tracked and only ever escalated (a failure is
 *   never downgraded back to success). Normal SIGINT/SIGTERM drains exit 0;
 *   configuration, fatal (uncaughtException / unhandledRejection), runtime
 *   server errors, and forced termination exit non-zero.
 *
 * Logging (CWE-532 / CWE-117):
 *   Errors are logged as a single, sanitized `name [code]: message` line in
 *   EVERY environment by default - control and line-break characters are
 *   stripped so an attacker-influenced message cannot inject extra log lines or
 *   terminal escapes, and arbitrary (non-Error) rejection payloads are never
 *   serialized wholesale. Full stack traces (which can leak filesystem paths and
 *   internals) are emitted ONLY behind an explicit diagnostic opt-in
 *   (`SERVER_DEBUG=1`); they are never shown by default, including on a direct
 *   `node server.js` run where NODE_ENV is unset.
 *
 * Design constraints (see Agent Action Plan):
 *   - JavaScript / Node.js only, CommonJS, ZERO third-party dependencies
 *     (only the Node core `http` module and the `process` global are used).
 *   - The valid-request fast path stays minimal with no synchronous blocking,
 *     and every lifecycle timer is unref'd so it never keeps the event loop
 *     alive (hard performance constraint).
 *   - The runnable entry point remains `node server.js` (auto-starts on run).
 */

// ---------------------------------------------------------------------------
// Dependencies (Node.js built-ins ONLY - the zero-dependency posture is
// intentional and must be preserved).
// ---------------------------------------------------------------------------
const http = require('http');

// ---------------------------------------------------------------------------
// Configuration constants
//
// Defaults preserve the original server's behavior exactly. Host and port are
// environment-overridable (see loadConfiguration); everything else is a named
// constant for clarity and easy auditing.
// ---------------------------------------------------------------------------

// Original defaults - used verbatim when HOST / PORT are not provided.
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

// Valid TCP port range. Port 0 is accepted deliberately (asks the OS for an
// ephemeral port); the real bound port is reported at startup.
const MIN_PORT = 0;
const MAX_PORT = 65535;

// Maximum accepted request body size (bytes). Bodies larger than this are
// rejected with 413 before any unbounded buffering occurs (DoS mitigation).
const MAX_BODY_SIZE = 1024 * 1024; // 1 MiB

// Maximum time (ms) to wait for in-flight requests to drain during a graceful
// shutdown before connections are forcibly destroyed.
const SHUTDOWN_TIMEOUT_MS = 10000; // 10 s

// Robust-processing timeouts (slowloris / slow-client resistance).
const REQUEST_TIMEOUT_MS = 30000; // 30 s - total time to receive a request
const HEADERS_TIMEOUT_MS = 20000; // 20 s - time to receive the request headers
const KEEPALIVE_TIMEOUT_MS = 5000; //  5 s - idle keep-alive socket timeout

// How often (ms) Node scans in-flight connections for headersTimeout /
// requestTimeout violations. Node's default is 30000, which makes the 20 s
// headers timeout only actionable at the next 30 s scan boundary (a partial-
// header client was observed to be dropped at ~30 s, not ~20 s - SRV-FINAL-05).
// A smaller interval enforces the configured header/request timeouts close to
// their real values. It is a periodic background scan that never touches the
// request fast path, so the hard performance constraint is preserved.
const CONNECTIONS_CHECKING_INTERVAL_MS = 2000; // 2 s

// Only safe, side-effect-free methods are served by this endpoint.
const ALLOWED_METHODS = ['GET', 'HEAD'];

// Node surfaces request/header timeouts to 'clientError' with this code; it is
// a timeout (answer 408), not malformed syntax (which would be answered 400).
const REQUEST_TIMEOUT_CODE = 'ERR_HTTP_REQUEST_TIMEOUT';

// Stack traces can leak filesystem paths and internal details (CWE-532), so
// they are NEVER emitted by default in any environment. They are included only
// when an operator explicitly opts in with `SERVER_DEBUG=1`. The previous
// NODE_ENV-based rule leaked stacks whenever NODE_ENV was unset (the common
// direct-run case); default-safe logging is now the invariant (SRV-FINAL-02).
const SHOW_STACK = process.env.SERVER_DEBUG === '1';

// ---------------------------------------------------------------------------
// Module-level runtime state
// ---------------------------------------------------------------------------

// Registry of live sockets, used for deterministic teardown on shutdown and as
// a portable fallback when closeIdleConnections/closeAllConnections are absent.
const sockets = new Set();

// Sockets whose connection-level failure has already been logged, so a single
// underlying reset/abort is not logged twice by overlapping listeners
// (clientError vs req/res stream 'error'). Keyed weakly so entries disappear
// with their socket (SRV-11).
const failureLogged = new WeakSet();

// Sockets on which a complete HTTP response was emitted for the request
// currently bound to that socket *before that request had fully arrived* (an
// early 413 body-cap rejection or a request-stream 400). The server-level
// 'clientError' handler consults this so it never synthesizes a SECOND
// response (e.g. a spurious 400 after a 413 for an oversized body that the
// client then aborted), which would put two responses on one connection - an
// HTTP/1.1 framing violation with response-desync / request-smuggling
// potential (SRV-12).
//
// Only PRE-COMPLETION responses are ever marked. A normal response emitted
// AFTER the request has fully arrived (a routed 200/404/405/500 produced from
// the req 'end' handler) is deliberately NOT marked: its request is already
// complete, so no second response can be provoked for it, and marking it would
// leave a stale per-socket flag that survives keep-alive reuse and suppress a
// legitimate 400/408 (and its error log) on the NEXT request over that socket
// (SRV-REG-01). The mark is cleared on 'end', 'close', and in 'clientError'
// itself, so a later request reusing the same keep-alive socket always starts
// unmarked. Keyed weakly so entries disappear with their socket.
const respondedForRequest = new WeakSet();

// Per-socket count of requests that have been ACCEPTED (a ServerResponse
// exists) but whose response has not yet settled. This underpins the
// coalesced-pipeline ordering guarantee (ACCEPT-F1): the server-level
// 'clientError' handler consults it so that a raw 400/408 synthesized for
// LATER malformed bytes in the same TCP segment is never written ahead of (or
// in place of) an earlier, already-accepted valid request's still-pending
// response. Without this, a single write of "GET / <valid>" immediately
// followed by "<malformed>" made Node dispatch the valid request (whose
// response this server defers until the body drains at req 'end') and then
// synchronously emit 'clientError' for the malformed bytes; writing the 400 at
// that instant half-closed the socket and discarded the pending 200, so the
// client saw only [400] and never the greeting. Keyed weakly so entries
// disappear with their socket.
const inFlightResponses = new WeakMap();

// A client error (parser-malformed -> 400, or a request/headers timeout ->
// 408) that arrived while a response was still in flight on the socket, held
// here so flushPendingClientError() can emit it in correct order ONLY after the
// earlier response(s) have drained ([200] then [400]) instead of racing and
// suppressing them (ACCEPT-F1). Stores just the classifying error code; keyed
// weakly so entries disappear with their socket.
const pendingClientError = new WeakMap();

// Guard that makes shutdown() idempotent so repeated signals never double-run.
let isShuttingDown = false;

// Becomes true once the server has successfully begun listening. Used to
// distinguish bind/startup errors (no resources to clean up) from runtime
// errors that occur after the server is live (SRV-04).
let hasListened = false;

// The process exit code, only ever escalated upward (a recorded failure is
// never downgraded back to success). See requestExit / finalizeExit (SRV-05).
let exitCode = 0;

// Ensures the process exits exactly once, with the final recorded code.
let exitFinalized = false;

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/**
 * Collapse a value to a single safe log token: coerce to string and replace CR,
 * LF, tab and every other C0/C1 control character with a single space. This
 * prevents an attacker-influenced value (e.g. an error message derived from
 * request input) from injecting extra log lines or terminal escape sequences
 * into the log stream - i.e. log-forging / amplification (CWE-117 / CWE-532).
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeLogValue(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

/**
 * Produce a sanitized, single-line description of an error for logging.
 *
 * Includes the error's name, code (if any) and message - each individually
 * sanitized to a single line - but NOT its stack trace unless the explicit
 * diagnostic opt-in `SERVER_DEBUG=1` is set, since stack traces can leak
 * filesystem paths and internals (CWE-532). Arbitrary non-Error values (e.g. a
 * rejected non-Error) are described by type only; their raw payload is never
 * serialized wholesale as it may contain secrets or PII.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err instanceof Error) {
    const code = err.code ? ` [${sanitizeLogValue(err.code)}]` : '';
    const base = `${sanitizeLogValue(err.name)}${code}: ${sanitizeLogValue(err.message)}`;
    // The stack is the ONE place multi-line output is permitted, and only under
    // the explicit SERVER_DEBUG=1 opt-in. It is intentionally NOT sanitized so a
    // diagnosing operator sees the real frames; it is never emitted by default.
    return SHOW_STACK && err.stack ? `${base}\n${err.stack}` : base;
  }
  // Non-Error rejection/throw value: report only its type, never its content.
  return `non-error value of type ${typeof err}`;
}

/**
 * Log a connection-level failure at most once per underlying socket, so a
 * single reset/abort observed by multiple overlapping listeners (server
 * 'clientError' and the request/response stream 'error') does not produce
 * duplicate, attacker-amplifiable log lines (SRV-11).
 *
 * @param {import('net').Socket|undefined|null} socket
 * @param {string} context
 * @param {unknown} err
 */
function logConnectionFailureOnce(socket, context, err) {
  if (socket) {
    if (failureLogged.has(socket)) {
      return;
    }
    failureLogged.add(socket);
  }
  console.error(`${context}: ${describeError(err)}`);
}

// ---------------------------------------------------------------------------
// Configuration loading
// ---------------------------------------------------------------------------

/**
 * Report a fatal configuration error and terminate the process non-zero.
 * Called before the server begins listening, so there are no resources to
 * clean up - failing fast here is correct (SRV-01 / SRV-05).
 *
 * @param {string} message - sanitized, human-readable reason
 * @returns {never}
 */
function configurationError(message) {
  console.error(`Configuration error: ${message}`);
  process.exit(1);
}

/**
 * Parse and validate HOST / PORT from the environment, falling back to the
 * original defaults so behavior is identical when no variables are set.
 *
 * Invalid values are rejected fast with a sanitized diagnostic and a non-zero
 * exit rather than being silently coerced (the legacy `Number(x) || 3000`
 * turned `abc`, whitespace and `0` into 3000) or deferred to a later
 * `listen()` crash (negative / fractional / out-of-range values threw
 * ERR_SOCKET_BAD_PORT). See SRV-01.
 *
 * @returns {{ hostname: string, port: number }}
 */
function loadConfiguration() {
  // HOST: default to loopback. A provided value is trimmed; empty or
  // control-character values are rejected. Any other non-empty string is
  // accepted as-is (valid DNS names and IPv4/IPv6 literals are not
  // second-guessed here - the OS resolver validates them at listen time).
  let hostname = DEFAULT_HOST;
  if (process.env.HOST !== undefined) {
    const rawHost = process.env.HOST.trim();
    // eslint-disable-next-line no-control-regex
    if (rawHost === '' || /[\u0000-\u001f\u007f]/.test(rawHost)) {
      configurationError('HOST must be a non-empty string without control characters.');
    }
    hostname = rawHost;
  }

  // PORT: default to 3000. A provided value must be an explicit run of decimal
  // digits (this rejects '', whitespace-only, '1.5', '-1', '0x10', 'abc' and
  // 'Infinity') that parses to an integer within [0, 65535]. Port 0 is
  // accepted deliberately (ephemeral port).
  let port = DEFAULT_PORT;
  if (process.env.PORT !== undefined) {
    const rawPort = process.env.PORT.trim();
    const parsed = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
      configurationError(`PORT must be an integer between ${MIN_PORT} and ${MAX_PORT}.`);
    }
    port = parsed;
  }

  return { hostname, port };
}

// ---------------------------------------------------------------------------
// Request routing
//
// Routing decisions are made only after the request body has been safely
// consumed (see handleRequest). Order of checks: method -> target -> fast path.
// Every response is emitted through the guarded `finalize` helper so exactly
// one terminal action is taken per request.
// ---------------------------------------------------------------------------

/**
 * Emit a generic 500 response for an unexpected server-side error without
 * leaking internal details to the client. Routed through the guarded
 * `finalize` helper, so it safely destroys the response if headers were
 * already sent.
 *
 * @param {(status: number, headers: object, body?: string) => void} finalize
 * @param {unknown} err
 */
function sendServerError(finalize, err) {
  console.error(`Unhandled error while processing request: ${describeError(err)}`);
  finalize(500, { 'Content-Type': 'text/plain' }, 'Internal Server Error');
}

/**
 * Validate and route a fully-received request.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {(status: number, headers: object, body?: string) => void} finalize
 */
function routeRequest(req, res, finalize) {
  // Input validation: reject unsupported methods with 405 + Allow.
  if (!ALLOWED_METHODS.includes(req.method)) {
    finalize(
      405,
      { 'Content-Type': 'text/plain', Allow: ALLOWED_METHODS.join(', ') },
      'Method Not Allowed'
    );
    return;
  }

  // Input validation (SRV-07): the request target must be a non-empty string.
  // A malformed request object (missing/empty/non-string url) gets one safe,
  // generic 400 rather than being treated as root or throwing on `.split`.
  const target = req.url;
  if (typeof target !== 'string' || target.length === 0) {
    finalize(400, { 'Content-Type': 'text/plain' }, 'Bad Request');
    return;
  }

  // Only the root path is served. A query string such as "/?x=1" still
  // resolves to the root "/"; anything else is 404 (behavior unchanged).
  const pathname = target.split('?')[0];
  if (pathname !== '/') {
    finalize(404, { 'Content-Type': 'text/plain' }, 'Not Found');
    return;
  }

  // Preserved default behavior - the backward-compatible fast path. A valid
  // GET / returns exactly: 200, Content-Type: text/plain, body
  // "Hello, World!\n". HEAD returns the same status/headers with no body per
  // RFC 9110 (a message body must not be sent in a response to HEAD).
  const body = req.method === 'HEAD' ? undefined : 'Hello, World!\n';
  finalize(200, { 'Content-Type': 'text/plain' }, body);
}

// ---------------------------------------------------------------------------
// Request handler
//
// Owns per-request terminal state so exactly one terminal action (a full
// response or a destroy) is ever taken, enforces the body-size cap as data
// streams in (never buffering unbounded data), and routes the request only
// once its body has been fully and safely consumed.
// ---------------------------------------------------------------------------

/**
 * Top-level request handler wired into http.createServer.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function handleRequest(req, res) {
  // Single owner of terminal state for this exchange. `finalized` flips to true
  // the instant any terminal action begins, and every guarded helper below
  // no-ops afterwards - eliminating the CWE-367 races where independent async
  // events (data / end / error / close) each tried to respond (SRV-02).
  // `ended` flips to true the moment the request has fully arrived (req 'end'),
  // and is used by finalize() to distinguish an EARLY (pre-completion) response
  // - which must be recorded on the socket to block a duplicate clientError
  // response (SRV-12) - from a normal post-completion routed response, which
  // must NOT be recorded or it would strand a stale mark across keep-alive
  // reuse and suppress the next connection's 400/408 (SRV-REG-01).
  const state = { finalized: false, limitExceeded: false, ended: false };

  /**
   * Guarded terminal write: emit a full response exactly once. If the request
   * is already terminal, or the response can no longer be written cleanly
   * (headers sent / already ended / destroyed), the socket is destroyed
   * instead of attempting an illegal second write.
   *
   * @param {number} statusCode
   * @param {object} headers
   * @param {string} [body]
   */
  const finalize = (statusCode, headers, body) => {
    if (state.finalized) {
      return;
    }
    state.finalized = true;

    if (res.headersSent || res.writableEnded || res.destroyed) {
      if (!res.destroyed) {
        res.destroy();
      }
      return;
    }

    // If this response is being emitted BEFORE the request has fully arrived
    // (an early 413 body-cap rejection, or a request-stream 400), record it on
    // the socket so the server-level 'clientError' handler will not synthesize
    // a SECOND response for this same in-flight request should the client then
    // abort the still-draining body - two responses on one connection is an
    // HTTP/1.1 framing violation with response-desync potential (SRV-12). The
    // mark is set BEFORE the terminal write to close any re-entrancy window,
    // and ONLY for pre-completion responses (!state.ended): a normal
    // post-'end' routed 200/404/405/500 is never marked, or the stale flag
    // would survive keep-alive reuse and suppress a legitimate 400/408 (and its
    // error log) on the next request over this socket (SRV-REG-01). The mark is
    // cleared on req 'end', req 'close', and within the clientError handler.
    if (!state.ended && req.socket) {
      respondedForRequest.add(req.socket);
    }

    try {
      res.writeHead(statusCode, headers);
      if (body === undefined) {
        res.end();
      } else {
        res.end(body);
      }
    } catch (writeErr) {
      // A teardown race (socket vanished mid-write) can still throw; abandon
      // the exchange rather than let the throw escape as an uncaught error.
      logConnectionFailureOnce(req.socket, 'Response write failed', writeErr);
      if (!res.destroyed) {
        res.destroy();
      }
    }
  };

  /**
   * Guarded terminal abandon: mark the exchange terminal and destroy the
   * response exactly once, without attempting to write anything.
   */
  const abandon = () => {
    if (state.finalized) {
      return;
    }
    state.finalized = true;
    if (!res.destroyed) {
      res.destroy();
    }
  };

  // Top-level request-callback error boundary (SRV-FINAL-03). Wiring up the
  // per-request listeners below is the request "setup"; a synchronous failure
  // here (e.g. a malformed request object whose property access or listener
  // registration throws) is converted into a single generic 500 - when the
  // response is still writable - routed through the one terminal-state owner
  // (finalize), instead of escaping as an uncaughtException that would force a
  // full process shutdown and reset the client with ECONNRESET. Because
  // finalize()/abandon() are defined above (they cannot throw) and finalize is
  // idempotent, this 500 can never become a duplicate response. Each individual
  // asynchronous callback is additionally guarded below with its own catch, so
  // an unexpected throw inside data/end/error/close likewise becomes a
  // controlled 500 (or a safe abandon) rather than a process-fatal exception.
  try {
    // Coalesced-pipeline ordering (ACCEPT-F1): register this exchange as
    // in-flight on its socket BEFORE wiring the rest of the listeners, so that
    // if LATER malformed bytes in the same TCP segment provoke a 'clientError'
    // while this (already-accepted, valid) request's response is still pending,
    // the server writes the raw 400/408 only AFTER this response drains rather
    // than discarding it. The count is decremented automatically when the
    // response settles.
    trackInFlightResponse(req.socket, res);

    // Stream error listeners prevent an unhandled req/res error (e.g. a client
    // that aborts mid-flight) from crashing the process. A malformed/interrupted
    // request maps to a single safe 400 if we can still write; finalize() also
    // guarantees a later 'end' cannot route and respond a second time (SRV-02).
    req.on('error', (err) => {
      try {
        logConnectionFailureOnce(req.socket, 'Request stream error', err);
        finalize(400, { 'Content-Type': 'text/plain' }, 'Bad Request');
      } catch (cbErr) {
        // The stream is already in error; a clean response is impossible, so
        // just mark the exchange terminal rather than let the throw escape.
        abandon();
      }
    });

    res.on('error', (err) => {
      try {
        logConnectionFailureOnce(res.socket, 'Response stream error', err);
      } finally {
        // Always mark terminal on a response-stream error, even if logging threw.
        abandon();
      }
    });

    // If the request stream closes before a complete message was received (a
    // client abort/reset), mark the exchange terminal so a trailing event cannot
    // attempt a second response. No response is attempted or logged here - the
    // 'error' handler owns any failure logging for this connection (SRV-11).
    req.on('close', () => {
      try {
        // The request is over: clear any early-response mark for this socket so a
        // subsequent request reusing this keep-alive connection starts unmarked
        // and can receive its own error response (SRV-REG-01 / SRV-12).
        if (req.socket) {
          respondedForRequest.delete(req.socket);
        }
        if (!state.finalized && (req.destroyed || req.complete === false)) {
          abandon();
        }
      } catch (cbErr) {
        abandon();
      }
    });

    // Body-size enforcement (cross-cutting DoS guard). Bytes are counted as they
    // arrive and the request is rejected the moment the cap is exceeded, before
    // any unbounded buffering. Attaching a 'data' listener also drains the body
    // for normal (within-limit) requests so keep-alive sockets release cleanly.
    let received = 0;
    req.on('data', (chunk) => {
      try {
        if (state.finalized || state.limitExceeded) {
          return;
        }
        received += chunk.length;
        if (received > MAX_BODY_SIZE) {
          state.limitExceeded = true;

          // Emit one observable 413 and keep the connection alive so the
          // remainder of the (already counted, never buffered) oversized body
          // drains through the still-attached 'data' listener. This is
          // deliberate:
          //   * We do NOT set `Connection: close` or destroy the socket here.
          //     Forcing the socket shut while inbound body bytes are still
          //     unread makes TCP emit an RST, and an RST discards the
          //     just-written 413 from a slow/paused client's receive buffer -
          //     which is exactly how the previous implementation turned the 413
          //     into a bare ECONNRESET (SRV-03). Draining to 'end' and letting
          //     the keep-alive socket close normally yields a graceful FIN, so
          //     the 413 is reliably observed by clients that read the response
          //     late.
          //   * Draining never buffers (each discarded chunk is O(1) memory) and
          //     is bounded by the configured requestTimeout / keepAliveTimeout,
          //     so an endless body cannot hold the connection open indefinitely.
          // Subsequent 'data' events are ignored by the guard above while the
          // stream stays in flowing mode, so the body is discarded automatically
          // - no pause() and no premature destroy().
          finalize(413, { 'Content-Type': 'text/plain' }, 'Payload Too Large');
        }
      } catch (cbErr) {
        // An unexpected failure while measuring/rejecting the body becomes a
        // controlled 500 (idempotent) rather than an uncaught exception.
        sendServerError(finalize, cbErr);
      }
    });

    // The body has been fully and safely consumed: route the request. Guarded by
    // terminal state so a request that already failed (error) or was rejected
    // (413) is not routed again. The route call is wrapped so an unexpected throw
    // becomes a controlled 500 rather than an uncaught exception.
    req.on('end', () => {
      try {
        // The request has now been fully received. Flip `ended` FIRST - before
        // the route call below - so the response routeRequest() emits is treated
        // as a normal post-completion response and is NOT recorded on the socket
        // by finalize(); recording it would strand a stale mark that suppresses a
        // legitimate 400/408 on the next request reusing this keep-alive socket
        // (SRV-REG-01).
        state.ended = true;
        // Clear any early-response mark (e.g. from a 413 whose oversized body has
        // now fully drained): the request is complete, so a subsequent request
        // that reuses this keep-alive socket must start unmarked and be able to
        // receive its own error response (SRV-12). Done BEFORE the guard below so
        // it runs even for a body-capped (413) or already-finalized request.
        if (req.socket) {
          respondedForRequest.delete(req.socket);
        }
        if (state.finalized || state.limitExceeded) {
          return;
        }
        routeRequest(req, res, finalize);
      } catch (err) {
        sendServerError(finalize, err);
      }
    });
  } catch (setupErr) {
    // The synchronous listener wiring above threw. Convert it to a generic 500
    // when the response is still writable; finalize() safely destroys the
    // response instead if headers were already sent. This is the outer boundary
    // that closes the SRV-FINAL-03 gap where a setup-time failure previously
    // escaped to uncaughtException, forced a shutdown, and reset the client.
    sendServerError(finalize, setupErr);
  }
}

// ---------------------------------------------------------------------------
// CONNECT handling
//
// Node dispatches a CONNECT request through the special 'connect' event, NOT
// through the ordinary 'request' event, so it bypasses handleRequest entirely.
// With no 'connect' listener the tunnel request received NO response at all
// (SRV-FINAL-01). This handler answers CONNECT with exactly the same ordinary
// contract as any other unsupported method - a single 405 Method Not Allowed
// carrying the Allow header - written directly to the raw tunnel socket (a
// 'connect' event has no ServerResponse), then closes the connection.
// ---------------------------------------------------------------------------

/**
 * Reject a CONNECT tunnel request with a single 405 Method Not Allowed that
 * carries the ordinary `Allow` contract, then close the socket. Guarded so a
 * socket that is already gone / unwritable is simply destroyed and a teardown
 * race can never escape as an uncaught error. Like an ordinary 405 this is a
 * normal, expected rejection and is therefore not logged.
 *
 * @param {http.IncomingMessage} _req  - the CONNECT request (unused)
 * @param {import('net').Socket} socket - the raw tunnel socket
 */
function handleConnect(_req, socket) {
  if (!socket) {
    return;
  }
  const body = 'Method Not Allowed';
  const response =
    'HTTP/1.1 405 Method Not Allowed\r\n' +
    `Allow: ${ALLOWED_METHODS.join(', ')}\r\n` +
    'Content-Type: text/plain\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n' +
    '\r\n' +
    body;
  try {
    if (socket.writable && !socket.destroyed) {
      // end() writes the 405 and sends a FIN, closing the tunnel cleanly.
      socket.end(response);
    } else if (!socket.destroyed) {
      socket.destroy();
    }
  } catch (err) {
    logConnectionFailureOnce(socket, 'CONNECT rejection failed', err);
    if (!socket.destroyed) {
      socket.destroy();
    }
  }
}

// ---------------------------------------------------------------------------
// Coalesced-pipeline response ordering (ACCEPT-F1)
//
// When a client coalesces a valid request and following malformed bytes into a
// single TCP segment, Node parses and dispatches the valid request (whose
// response this server defers until the body has drained at req 'end') and
// then SYNCHRONOUSLY emits 'clientError' for the malformed bytes - before the
// valid request's deferred response has been written. Writing a raw 400 to the
// socket at that instant (which also half-closes it) discards the still-pending
// valid response, so the client sees only [400] and never the 200.
//
// These two helpers let the 'clientError' handler DEFER its raw status line
// until every in-flight response on that socket has settled, after which the
// 400/408 is appended in correct order ([200] then [400]) and the connection is
// closed - matching both the original server's response preservation and this
// server's own behavior when the two requests arrive with any time gap. The
// mechanism is a per-socket counter plus a one-shot 'close' listener; it never
// touches the valid-request fast path beyond an O(1) map write and a single
// listener, so the hard performance constraint is preserved.
// ---------------------------------------------------------------------------

/**
 * Record that a response has been accepted on `socket` and will settle
 * asynchronously, and arrange to decrement that count once the response
 * closes. When the socket's in-flight count returns to zero, any client error
 * that was deferred while responses were pending is flushed in correct order.
 *
 * @param {import('net').Socket|undefined|null} socket
 * @param {http.ServerResponse} res
 */
function trackInFlightResponse(socket, res) {
  if (!socket) {
    return;
  }
  inFlightResponses.set(socket, (inFlightResponses.get(socket) || 0) + 1);

  // 'close' is emitted exactly once per ServerResponse. For a normally
  // completed response it fires AFTER 'finish' (i.e. after the response bytes
  // have been flushed to the socket), so a deferred 400/408 appended here lands
  // strictly after the completed response; on an aborted response it still
  // fires, so the count can never be stranded above zero. Decrement, and once
  // the socket has no more pending responses, emit any deferred client error.
  res.once('close', () => {
    const remaining = (inFlightResponses.get(socket) || 1) - 1;
    if (remaining > 0) {
      inFlightResponses.set(socket, remaining);
      return;
    }
    inFlightResponses.delete(socket);
    flushPendingClientError(socket);
  });
}

/**
 * Emit a previously deferred client-error status line now that every earlier
 * response on the socket has drained, then close the connection with a FIN. The
 * status matches the deferred error's classification - 408 for a request/
 * headers timeout, 400 for parser-malformed input - mirroring the immediate
 * (non-deferred) paths in the 'clientError' handler. A no-op when nothing was
 * deferred or the socket is already gone / unwritable.
 *
 * @param {import('net').Socket|undefined|null} socket
 */
function flushPendingClientError(socket) {
  if (!socket) {
    return;
  }
  const pending = pendingClientError.get(socket);
  if (!pending) {
    return;
  }
  pendingClientError.delete(socket);
  if (socket.destroyed || !socket.writable) {
    return;
  }
  if (pending.code === REQUEST_TIMEOUT_CODE) {
    socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
  } else {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  }
}

// ---------------------------------------------------------------------------
// Server construction and event wiring
// ---------------------------------------------------------------------------

/**
 * Create the HTTP server, configure robust-processing timeouts, and wire the
 * lifecycle/error/connection listeners. Kept as a single named flow so server
 * construction is a clearly delineated concern (SRV-08).
 *
 * @returns {http.Server}
 */
function createAndConfigureServer() {
  // connectionsCheckingInterval is passed as a construction option (not a
  // post-hoc property) because Node schedules the incomplete-request scan timer
  // at construction; a smaller interval makes the headersTimeout / requestTimeout
  // effective close to their configured values instead of only at the default
  // 30 s scan boundary (SRV-FINAL-05).
  const httpServer = http.createServer(
    { connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS },
    handleRequest
  );

  // Robust-processing timeouts guard against slow or stalled clients.
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
  httpServer.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;

  // Record that the server is live so the 'error' handler can distinguish a
  // bind/startup failure from a later runtime failure (SRV-04).
  httpServer.on('listening', () => {
    hasListened = true;
  });

  // Server 'error' handling with startup-vs-runtime classification (SRV-04):
  //  - Before listening (bind failure such as EADDRINUSE / EACCES): no
  //    resources exist to drain, so log and terminate non-zero directly.
  //  - After listening (runtime/shutdown-time error): preserve a non-zero exit
  //    code and enter the idempotent cleanup path so in-flight work drains and
  //    sockets are torn down before the process exits.
  httpServer.on('error', (err) => {
    if (!hasListened) {
      // Sanitized, single-line diagnostic (still carries the [code], e.g.
      // [EADDRINUSE] / [EACCES]) - no stack unless SERVER_DEBUG=1 (SRV-FINAL-02).
      console.error(`Server startup error: ${describeError(err)}`);
      process.exit(1);
      return;
    }
    handleFatalError('serverError', err);
  });

  // Malformed-request / client-error handling (SRV-09):
  //  - A request/header timeout is a timeout, not malformed syntax: answer 408.
  //  - Parser-malformed input (HPE_* etc.) gets 400.
  //  - Already-reset (ECONNRESET) or unwritable sockets get no write (it would
  //    just error again); routine resets are not logged (SRV-10 / SRV-11).
  httpServer.on('clientError', (err, socket) => {
    const canWrite = Boolean(socket) && socket.writable && !socket.destroyed;

    // Response-desync guard (SRV-12): if a complete response has already been
    // emitted for the request currently bound to this socket (e.g. a 413 for an
    // oversized body that the client then aborted, which surfaces here as
    // HPE_INVALID_EOF_STATE), synthesizing another response would put two HTTP
    // responses on one connection - a framing violation a proxy could treat as
    // a response-splitting / request-smuggling primitive. Do NOT write a second
    // response; instead end our side gracefully with a FIN, which flushes the
    // already-written response rather than discarding it with an RST (the 413
    // path deliberately kept the socket writable for exactly this reason,
    // SRV-03). The connection is then done.
    if (socket && respondedForRequest.has(socket)) {
      respondedForRequest.delete(socket);
      if (canWrite) {
        socket.end();
      }
      return;
    }

    if (err.code === 'ECONNRESET' || !canWrite) {
      if (err.code !== 'ECONNRESET') {
        logConnectionFailureOnce(socket, 'Client error', err);
      }
      return;
    }

    // Coalesced-pipeline ordering guard (ACCEPT-F1): if a response for an
    // earlier, already-accepted request on this socket is still in flight (the
    // classic case is a single TCP segment carrying "GET / <valid>" immediately
    // followed by "<malformed>": Node dispatches the valid request - whose
    // response is deferred until its body drains at req 'end' - and then
    // synchronously lands here for the malformed bytes), writing the raw status
    // line NOW would be injected ahead of, or would half-close the socket and
    // discard, that pending response, suppressing it entirely. Reaching this
    // point means the socket is still writable and the error is not a bare
    // reset, so instead of racing the pending response we DEFER the status line;
    // flushPendingClientError() emits it in correct order ([200] then [400]/
    // [408]) and closes the connection once the socket's in-flight responses
    // have drained. A standalone malformed request never dispatched a 'request'
    // event (its headers never parsed), so its in-flight count is zero and it
    // still takes the immediate paths below unchanged.
    if ((inFlightResponses.get(socket) || 0) > 0) {
      if (!pendingClientError.has(socket)) {
        pendingClientError.set(socket, { code: err.code });
        // Log once now (deduplicated per socket); the deferred flush only
        // writes bytes, mirroring the immediate paths' "log then respond".
        const context =
          err.code === REQUEST_TIMEOUT_CODE ? 'Client request timeout' : 'Client error';
        logConnectionFailureOnce(socket, context, err);
      }
      return;
    }

    if (err.code === REQUEST_TIMEOUT_CODE) {
      logConnectionFailureOnce(socket, 'Client request timeout', err);
      socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
      return;
    }

    logConnectionFailureOnce(socket, 'Client error', err);
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  // CONNECT tunnel requests arrive on the special 'connect' event and bypass
  // handleRequest; answer them with the ordinary 405 + Allow contract and close
  // the socket, so every unsupported method - CONNECT included - is rejected
  // consistently (SRV-FINAL-01).
  httpServer.on('connect', handleConnect);

  // Connection tracking (resource cleanup): remember every live socket and
  // forget it once closed, so shutdown can tear down stragglers
  // deterministically even on Node versions lacking closeAllConnections.
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  return httpServer;
}

// Runtime singletons. These are assigned by main() only when the file is run
// directly (`node server.js`). They are declared at module scope - not as
// top-level `const` initializers - so the lifecycle functions (startServer /
// shutdown / handleFatalError) can reference them, while they remain unset when
// the module is merely `require`d (e.g. by the test suite). Guarding all
// side-effectful startup behind main()/require.main means importing server.js
// performs NO config read, creates NO server, opens NO port, and registers NO
// process/signal handlers - so an importer's process is never mutated.
let hostname;
let port;
let server;

// ---------------------------------------------------------------------------
// Exit-code integrity
// ---------------------------------------------------------------------------

/**
 * Record a requested process exit code, only ever escalating upward. A
 * previously recorded failure (non-zero) is never downgraded back to success
 * by a later normal code path (SRV-05).
 *
 * @param {number} code
 */
function requestExit(code) {
  if (code > exitCode) {
    exitCode = code;
  }
}

/**
 * Terminate the process exactly once, using the highest recorded exit code.
 *
 * @returns {never|void}
 */
function finalizeExit() {
  if (exitFinalized) {
    return;
  }
  exitFinalized = true;
  process.exit(exitCode);
}

/**
 * Handle a fatal error (uncaught exception, unhandled rejection, or a runtime
 * server error): log it sanitized, record a non-zero exit code that survives
 * the shutdown drain, and enter the idempotent shutdown so cleanup runs before
 * the process exits non-zero (SRV-05). This is the last-resort safety net -
 * it is non-recursive because shutdown() is guarded.
 *
 * @param {string} context
 * @param {unknown} err
 */
function handleFatalError(context, err) {
  console.error(`Fatal error (${context}): ${describeError(err)}`);
  requestExit(1);
  shutdown(context);
}

// ---------------------------------------------------------------------------
// Lifecycle: startup and graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Format a `host:port` authority for a startup URL, bracketing IPv6 literals so
 * the emitted URL is valid and copyable. An IPv6 literal contains ':' and per
 * RFC 3986 / RFC 9110 MUST be wrapped in square brackets inside a URL authority
 * (`http://[::1]:3000/`); IPv4 addresses and hostnames contain no ':' and are
 * used verbatim, so the default line remains exactly `127.0.0.1:3000`
 * (SRV-FINAL-04).
 *
 * @param {string} host
 * @param {number} portNumber
 * @returns {string}
 */
function formatAuthority(host, portNumber) {
  const hostPart = typeof host === 'string' && host.includes(':') ? `[${host}]` : host;
  return `${hostPart}:${portNumber}`;
}

/**
 * Start listening. The startup log line is preserved verbatim from the
 * original server; the real bound port (from server.address()) is used so the
 * default case logs exactly `http://127.0.0.1:3000/` while an ephemeral
 * PORT=0 reports the actual assigned port. IPv6 hosts are bracketed via
 * formatAuthority so the logged URL is always valid (SRV-FINAL-04).
 */
function startServer() {
  server.listen(port, hostname, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    console.log(`Server running at http://${formatAuthority(hostname, boundPort)}/`);
  });
}

/**
 * Graceful shutdown: stop accepting new connections, drain in-flight requests,
 * and exit with the recorded code when drained. A bounded, unref'd force timer
 * is armed BEFORE any cleanup that could throw, so a synchronous failure can
 * never strand the process (SRV-06). Idempotent - repeated signals are ignored
 * after the first (SRV-06 re-entrancy guard). Normal signals exit 0; a recorded
 * fatal/runtime failure exits non-zero (SRV-05).
 *
 * @param {string} signal - The signal or reason that triggered the shutdown.
 */
function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`Received ${signal}, shutting down gracefully...`);

  // Arm the bounded, unref'd force/finalization fallback FIRST - before any
  // cleanup below that could throw - so nothing can leave the process running
  // without a scheduled exit. If connections do not drain in time, remaining
  // sockets are torn down and the process exits non-zero. unref() ensures the
  // timer never keeps the event loop (and therefore the process) alive.
  const forceTimer = setTimeout(() => {
    console.error('Forced shutdown: connections did not drain in time.');
    requestExit(1);
    try {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      sockets.forEach((socket) => socket.destroy());
    } catch (teardownErr) {
      console.error(`Error during forced connection teardown: ${describeError(teardownErr)}`);
    }
    finalizeExit();
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  try {
    // Release idle keep-alive connections so server.close() can complete
    // promptly. Guarded by typeof for portability across Node versions
    // (closeIdleConnections is available on Node 18.2+); the sockets Set is the
    // fallback used by the force timer above.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    if (server.listening) {
      // Stop accepting new connections and finalize once in-flight work drains.
      server.close((closeErr) => {
        if (closeErr) {
          // e.g. ERR_SERVER_NOT_RUNNING - record but do not mask a prior code.
          console.error(`Error closing server: ${describeError(closeErr)}`);
          requestExit(1);
        }
        clearTimeout(forceTimer);
        finalizeExit();
      });
    } else {
      // Not listening (e.g. a fatal error before/at startup): nothing to drain,
      // so finalize immediately with whatever code has been recorded.
      clearTimeout(forceTimer);
      finalizeExit();
    }
  } catch (cleanupErr) {
    // Cleanup setup itself threw: escalate to a deterministic non-zero exit
    // rather than leaving the process half-shut-down and still serving (SRV-06).
    console.error(`Error initiating shutdown: ${describeError(cleanupErr)}`);
    requestExit(1);
    clearTimeout(forceTimer);
    finalizeExit();
  }
}

// ---------------------------------------------------------------------------
// Process-level safety nets + signal registration
// ---------------------------------------------------------------------------

/**
 * Register the signal handlers (graceful shutdown) and the last-resort
 * process-level safety nets. Kept in a named function - invoked only by main()
 * - so that merely requiring this module never installs global process
 * listeners on the importer (the test suite requires it for unit tests).
 */
function registerProcessHandlers() {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Last-resort safety nets: record a non-zero exit code, log the fault
  // sanitized, and shut down gracefully rather than leaving the process in an
  // undefined state or exiting successfully after a fatal error (SRV-05 / SRV-10).
  process.on('uncaughtException', (err) => handleFatalError('uncaughtException', err));
  process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compose the runtime: load & validate configuration (fails fast on invalid
 * HOST/PORT), build and wire the server, install process handlers, and begin
 * listening. Assigns the module-level runtime singletons used by the lifecycle
 * functions.
 */
function main() {
  const config = loadConfiguration();
  hostname = config.hostname;
  port = config.port;
  server = createAndConfigureServer();
  registerProcessHandlers();
  startServer();
}

// Auto-start ONLY when executed directly (`node server.js`), preserving the
// original run behavior exactly. When this file is instead `require`d as a
// module (e.g. by server.test.js for deterministic in-process unit tests of the
// pure handlers/helpers) nothing runs: no config load, no server, no listen, no
// process handlers - so the importing process is never mutated.
if (require.main === module) {
  main();
}

// Testability surface (see the require.main guard above). Exporting these does
// NOT change the runtime: running the file directly still auto-starts, and an
// importer must call main()/startServer() explicitly. The set is kept small and
// deliberate - the pure/near-pure units needed to verify the request contract,
// CONNECT rejection, request error boundary, safe logging, and address
// formatting without spawning a process.
module.exports = {
  handleRequest,
  handleConnect,
  routeRequest,
  loadConfiguration,
  createAndConfigureServer,
  describeError,
  sanitizeLogValue,
  formatAuthority,
  ALLOWED_METHODS,
  MAX_BODY_SIZE,
};
