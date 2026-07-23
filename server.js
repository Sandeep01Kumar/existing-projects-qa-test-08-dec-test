'use strict';

/**
 * server.js - Express-based HTTP server with a hardened connection lifecycle.
 *
 * This is a small "tutorial" HTTP service that exposes two plaintext endpoints
 * built with the Express web framework:
 *
 *   GET /              -> 200 text/plain "Hello, World!\n"   (preserved default)
 *   GET /good-morning  -> 200 text/plain "Good morning\n"    (added endpoint)
 *
 * Express (the application/routing layer) is mounted onto a Node.js core
 * `http.Server` (the connection/lifecycle layer). Splitting responsibilities
 * this way lets Express own routing, request validation and response framing
 * while the underlying server keeps the production-grade reliability hardening:
 *
 *   1. Error handling      - Express 404 / 500 handlers, req/res stream error
 *                            listeners, listen-error classification, and
 *                            process-level uncaughtException / unhandledRejection
 *                            safety nets that record a non-zero exit code.
 *   2. Graceful shutdown   - SIGTERM / SIGINT driven drain via server.close()
 *                            with an idempotency guard and a bounded, unref'd
 *                            force-exit timer that is armed BEFORE any cleanup
 *                            that could throw, so shutdown can never strand the
 *                            process.
 *   3. Input validation    - body-size cap (413), method (405 + Allow), and path
 *                            (404) checks applied in that fixed precedence, plus
 *                            fail-fast validation of HOST / PORT config.
 *   4. Resource cleanup    - live-socket tracking, bounded body draining, and
 *                            deterministic connection teardown on shutdown.
 *   5. Robust processing    - request / headers / keep-alive timeouts, and
 *                            client-error handling that answers 408 for request
 *                            timeouts and 400 for parser-malformed input.
 *
 * Validation precedence (a single failing check determines the status):
 *   body-size cap (413) -> method (405) -> path (404). Method is checked before
 *   path, so an unsupported method returns 405 on ANY path (never 404); the body
 *   cap is enforced as the request streams in, before any routing.
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
 *   terminal escapes. Full stack traces are emitted ONLY behind an explicit
 *   diagnostic opt-in (`SERVER_DEBUG=1`).
 *
 * Design notes:
 *   - CommonJS module. The only third-party dependency is Express (added at the
 *     user's request); everything else uses Node.js built-ins (`http`, the
 *     `process` global, core timers).
 *   - The valid-request fast path stays minimal with no synchronous blocking,
 *     and every lifecycle timer is unref'd so it never keeps the event loop
 *     alive.
 *   - The runnable entry point remains `node server.js` (auto-starts on run);
 *     when the module is instead `require`d (e.g. by the test suite) nothing
 *     starts - no server, no port, no process/signal handlers.
 */

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------
const http = require('http');
const express = require('express');

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

// Grace period between writing a timed-out client's 408 and forcibly resetting
// the connection to reclaim its file descriptor. The 408 is written WITHOUT a
// FIN (the socket stays writable) so the response reaches a slow-but-reading
// client during this window; only after it elapses is the socket destroyed,
// which releases the descriptor deterministically and avoids a FIN_WAIT_2
// orphan against a non-reciprocating peer.
const CLIENT_TIMEOUT_LINGER_MS = 5000; // 5 s

// How often (ms) Node scans in-flight connections for headersTimeout /
// requestTimeout violations. Node's default is 30000, which would make the 20 s
// headers timeout only actionable at the next 30 s scan boundary. A smaller
// interval enforces the configured header/request timeouts close to their real
// values. It is a periodic background scan that never touches the request fast
// path, so the performance constraint is preserved.
const CONNECTIONS_CHECKING_INTERVAL_MS = 2000; // 2 s

// Only safe, side-effect-free methods are served by this API. HEAD is accepted
// and handled by Express's GET routes (the body is stripped automatically).
const ALLOWED_METHODS = ['GET', 'HEAD'];

// Node surfaces request/header timeouts to 'clientError' with this code; it is
// a timeout (answer 408), not malformed syntax (which would be answered 400).
const REQUEST_TIMEOUT_CODE = 'ERR_HTTP_REQUEST_TIMEOUT';

// Stack traces can leak filesystem paths and internal details (CWE-532), so
// they are NEVER emitted by default in any environment. They are included only
// when an operator explicitly opts in with `SERVER_DEBUG=1`.
const SHOW_STACK = process.env.SERVER_DEBUG === '1';

// Response bodies - single source of truth so the routes and the tests agree.
// The trailing newline on both preserves the original "Hello, World!\n" style.
const HELLO_BODY = 'Hello, World!\n';
const GOOD_MORNING_BODY = 'Good morning\n';

// The path of the added greeting endpoint.
const GOOD_MORNING_PATH = '/good-morning';

// ---------------------------------------------------------------------------
// Module-level runtime state
// ---------------------------------------------------------------------------

// Registry of live sockets, used for deterministic teardown on shutdown and as
// a portable fallback when closeIdleConnections/closeAllConnections are absent.
const sockets = new Set();

// Sockets whose connection-level failure has already been logged, so a single
// underlying reset/abort is not logged twice by overlapping listeners
// (clientError vs req/res stream 'error'). Keyed weakly so entries disappear
// with their socket.
const failureLogged = new WeakSet();

// Guard that makes shutdown() idempotent so repeated signals never double-run.
let isShuttingDown = false;

// Becomes true once the server has successfully begun listening. Used to
// distinguish bind/startup errors (no resources to clean up) from runtime
// errors that occur after the server is live.
let hasListened = false;

// The process exit code, only ever escalated upward (a recorded failure is
// never downgraded back to success). See requestExit / finalizeExit.
let exitCode = 0;

// Ensures the process exits exactly once, with the final recorded code.
let exitFinalized = false;

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/**
 * Collapse a value to a single safe log token: coerce to string and replace CR,
 * LF, tab and every other C0/C1 control character with a single space. This
 * prevents an attacker-influenced value from injecting extra log lines or
 * terminal escape sequences into the log stream (CWE-117 / CWE-532).
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
 * diagnostic opt-in `SERVER_DEBUG=1` is set. Arbitrary non-Error values are
 * described by type only; their raw payload is never serialized wholesale as it
 * may contain secrets or PII.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err instanceof Error) {
    const code = err.code ? ` [${sanitizeLogValue(err.code)}]` : '';
    const base = `${sanitizeLogValue(err.name)}${code}: ${sanitizeLogValue(err.message)}`;
    // The stack is the ONE place multi-line output is permitted, and only under
    // the explicit SERVER_DEBUG=1 opt-in. It is never emitted by default.
    return SHOW_STACK && err.stack ? `${base}\n${err.stack}` : base;
  }
  // Non-Error rejection/throw value: report only its type, never its content.
  return `non-error value of type ${typeof err}`;
}

/**
 * Log a connection-level failure at most once per underlying socket, so a
 * single reset/abort observed by multiple overlapping listeners does not
 * produce duplicate, attacker-amplifiable log lines.
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
 * clean up - failing fast here is correct.
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
 * exit rather than being silently coerced or deferred to a later listen()
 * crash.
 *
 * @returns {{ hostname: string, port: number }}
 */
function loadConfiguration() {
  // HOST: default to loopback. A provided value is trimmed; empty or
  // control-character values are rejected. Any other non-empty string is
  // accepted as-is (the OS resolver validates DNS names / IP literals at listen
  // time).
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
  // 'Infinity') that parses to an integer within [0, 65535]. Port 0 is accepted
  // deliberately (ephemeral port).
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
// Express application
//
// The app is organized as a short, ordered middleware pipeline that enforces
// the documented validation precedence (body-size cap -> method -> path) before
// the route handlers run, followed by a 404 catch-all and a 500 error handler.
// Each concern is a small, single-responsibility function.
// ---------------------------------------------------------------------------

/**
 * Send a plaintext response through Express. Centralizes the status/type/body
 * pattern so every response is emitted the same way. Express strips the body
 * for HEAD requests automatically while still reporting Content-Length.
 *
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} body
 */
function sendPlainText(res, status, body) {
  res.status(status).type('text/plain').send(body);
}

/**
 * Middleware: enforce the request-body size cap and drain the body.
 *
 * Bytes are counted as they stream in and the request is rejected with 413 the
 * moment the cap is exceeded - before any unbounded buffering (DoS mitigation).
 * Reading the stream to its 'end' also drains within-limit bodies so keep-alive
 * sockets release cleanly, and only then is `next()` called so routing always
 * runs against a fully-consumed request. Per-request req/res stream error
 * listeners are attached here (the first middleware) so an aborted/interrupted
 * connection can never escape as an unhandled stream 'error' and crash the
 * process.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function enforceBodyLimit(req, res, next) {
  // Stream error listeners: a client that aborts mid-flight surfaces as a req
  // (or res) 'error'; log it once and clean up rather than crash. A best-effort
  // 400 is attempted only while the response is still writable.
  req.on('error', (err) => {
    logConnectionFailureOnce(req.socket, 'Request stream error', err);
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      try {
        sendPlainText(res, 400, 'Bad Request');
      } catch (writeErr) {
        if (!res.destroyed) {
          res.destroy();
        }
      }
    } else if (!res.destroyed) {
      res.destroy();
    }
  });

  res.on('error', (err) => {
    logConnectionFailureOnce(res.socket, 'Response stream error', err);
    if (!res.destroyed) {
      res.destroy();
    }
  });

  let received = 0;
  let rejected = false;
  let advanced = false;

  const proceed = () => {
    if (advanced || rejected) {
      return;
    }
    advanced = true;
    next();
  };

  req.on('data', (chunk) => {
    if (rejected) {
      return;
    }
    received += chunk.length;
    if (received > MAX_BODY_SIZE) {
      rejected = true;
      // Emit one observable 413 and keep the connection writable so the 413 is
      // reliably delivered even to a slow/paused client (an RST here would
      // discard it). The remainder of the (already counted, never buffered)
      // oversized body is drained via resume(); each discarded chunk is O(1)
      // memory and draining is bounded by the configured request/keep-alive
      // timeouts, so an endless body cannot hold the connection open forever.
      if (!res.headersSent) {
        sendPlainText(res, 413, 'Payload Too Large');
      }
      req.resume();
    }
  });

  req.on('end', proceed);

  // A request whose stream closes without a normal 'end' (client abort) is
  // handled by the 'error'/'close' paths; nothing to route in that case.
  req.on('close', () => {
    // If the request closed cleanly after 'end', proceed() already ran; this is
    // a no-op then. If it closed early (abort), routing must not run.
    if (!advanced && !rejected && (req.destroyed || req.complete === false)) {
      rejected = true;
    }
  });
}

/**
 * Middleware: allow only the safe methods (GET / HEAD). Any other
 * parser-recognized method is answered with 405 and an `Allow` header, on ANY
 * path - method is validated before path, so `POST /` and `POST /anything`
 * both return 405 (never 404). Method tokens the HTTP parser does not
 * recognize never reach here: Node rejects them with 400 at the parser level.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function methodGuard(req, res, next) {
  if (!ALLOWED_METHODS.includes(req.method)) {
    res.set('Allow', ALLOWED_METHODS.join(', '));
    sendPlainText(res, 405, 'Method Not Allowed');
    return;
  }
  next();
}

/**
 * Route handler: the preserved default. A valid `GET /` returns exactly 200,
 * Content-Type text/plain, body "Hello, World!\n". `HEAD /` returns the same
 * status/headers with no body (Express strips it).
 */
function helloHandler(req, res) {
  sendPlainText(res, 200, HELLO_BODY);
}

/**
 * Route handler: the added greeting. `GET /good-morning` returns 200,
 * Content-Type text/plain, body "Good morning\n" (HEAD returns headers only).
 */
function goodMorningHandler(req, res) {
  sendPlainText(res, 200, GOOD_MORNING_BODY);
}

/**
 * Middleware: 404 catch-all for an allowed method on any unknown path. Runs
 * only after methodGuard, so it is only ever reached by GET/HEAD requests.
 */
function notFoundHandler(req, res) {
  sendPlainText(res, 404, 'Not Found');
}

/**
 * Express error-handling middleware (must take four arguments): convert any
 * unexpected downstream throw into a single generic 500 while the response is
 * still writable, without leaking internal details to the client. If headers
 * were already sent, the response is destroyed instead of attempting an illegal
 * second write.
 *
 * @param {unknown} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error(`Unhandled error while processing request: ${describeError(err)}`);
  if (res.headersSent || res.writableEnded) {
    if (!res.destroyed) {
      res.destroy();
    }
    return;
  }
  try {
    sendPlainText(res, 500, 'Internal Server Error');
  } catch (writeErr) {
    if (!res.destroyed) {
      res.destroy();
    }
  }
}

/**
 * Build and return the Express application. Creating an app has no I/O side
 * effects (no server, no port, no process listeners), so this is safe to call
 * from tests and at module load.
 *
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  // Do not advertise the framework, and keep responses byte-minimal (no ETag /
  // conditional-request machinery on these tiny plaintext bodies).
  app.disable('x-powered-by');
  app.disable('etag');

  // Validation precedence: body-size cap -> method -> path.
  app.use(enforceBodyLimit);
  app.use(methodGuard);

  // Routes. app.get also serves HEAD for the same path (body stripped).
  app.get('/', helloHandler);
  app.get(GOOD_MORNING_PATH, goodMorningHandler);

  // Unknown path (for an allowed method) -> 404.
  app.use(notFoundHandler);

  // Unexpected server-side error -> 500.
  app.use(errorHandler);

  return app;
}

// The singleton application used by the running server. Exported for tests.
const app = createApp();

// ---------------------------------------------------------------------------
// CONNECT handling
//
// Node dispatches a CONNECT request through the special 'connect' event, NOT
// through the ordinary request pipeline, so it bypasses the Express app. Answer
// it with the same contract as any other unsupported method - a single 405
// Method Not Allowed carrying the Allow header - written directly to the raw
// tunnel socket, then close the connection.
// ---------------------------------------------------------------------------

/**
 * Reject a CONNECT tunnel request with a single 405 Method Not Allowed that
 * carries the ordinary `Allow` contract, then close the socket. Guarded so a
 * socket that is already gone / unwritable is simply destroyed and a teardown
 * race can never escape as an uncaught error.
 *
 * @param {http.IncomingMessage} _req  - the CONNECT request (unused)
 * @param {import('net').Socket} socket - the raw tunnel socket
 */
function handleConnect(_req, socket) {
  if (!socket) {
    return;
  }
  try {
    if (socket.writable && !socket.destroyed) {
      const body = 'Method Not Allowed';
      socket.end(
        'HTTP/1.1 405 Method Not Allowed\r\n' +
          `Allow: ${ALLOWED_METHODS.join(', ')}\r\n` +
          'Content-Type: text/plain\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          'Connection: close\r\n' +
          '\r\n' +
          body
      );
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

/**
 * Answer a timed-out client with 408 and then release the connection. The 408
 * is written WITHOUT a FIN so a slow-but-reading client still receives it; the
 * socket is then reset after a bounded, unref'd linger so a non-reciprocating
 * peer cannot hold the file descriptor open in FIN_WAIT_2. A client that closes
 * after reading the 408 is released even sooner.
 *
 * @param {import('net').Socket} socket
 */
function answerTimeoutAndRelease(socket) {
  try {
    if (socket.writable && !socket.destroyed) {
      socket.write('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
      const linger = setTimeout(() => {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }, CLIENT_TIMEOUT_LINGER_MS);
      linger.unref();
    } else if (!socket.destroyed) {
      socket.destroy();
    }
  } catch (err) {
    logConnectionFailureOnce(socket, 'Timeout response failed', err);
    if (!socket.destroyed) {
      socket.destroy();
    }
  }
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

/**
 * Create the HTTP server around the Express app and attach the connection-level
 * hardening: robust-processing timeouts, listen-error classification,
 * client-error (malformed / timeout) handling, CONNECT rejection, and live
 * socket tracking for deterministic shutdown.
 *
 * @returns {http.Server}
 */
function createAndConfigureServer() {
  // connectionsCheckingInterval is passed as a construction option (not a
  // post-hoc property) because Node schedules the incomplete-request scan timer
  // at construction; a smaller interval makes the headersTimeout /
  // requestTimeout effective close to their configured values instead of only
  // at the default 30 s scan boundary.
  const httpServer = http.createServer(
    { connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS },
    app
  );

  // Robust-processing timeouts guard against slow or stalled clients.
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
  httpServer.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;

  // Record that the server is live so the 'error' handler can distinguish a
  // bind/startup failure from a later runtime failure.
  httpServer.on('listening', () => {
    hasListened = true;
  });

  // Server 'error' handling with startup-vs-runtime classification:
  //  - Before listening (bind failure such as EADDRINUSE / EACCES): no
  //    resources exist to drain, so log and terminate non-zero directly.
  //  - After listening (runtime error): preserve a non-zero exit code and enter
  //    the idempotent cleanup path so in-flight work drains and sockets are torn
  //    down before the process exits.
  httpServer.on('error', (err) => {
    if (!hasListened) {
      console.error(`Server startup error: ${describeError(err)}`);
      process.exit(1);
      return;
    }
    handleFatalError('serverError', err);
  });

  // Malformed-request / client-error handling:
  //  - A request/header timeout is a timeout, not malformed syntax: answer 408.
  //  - Parser-malformed input (HPE_* etc.) gets 400.
  //  - Already-reset (ECONNRESET) or unwritable sockets get no write (it would
  //    just error again); routine resets are not logged.
  httpServer.on('clientError', (err, socket) => {
    const canWrite = Boolean(socket) && socket.writable && !socket.destroyed;

    if (err.code === 'ECONNRESET' || !canWrite) {
      if (err.code !== 'ECONNRESET') {
        logConnectionFailureOnce(socket, 'Client error', err);
      }
      return;
    }

    if (err.code === REQUEST_TIMEOUT_CODE) {
      logConnectionFailureOnce(socket, 'Client request timeout', err);
      answerTimeoutAndRelease(socket);
      return;
    }

    logConnectionFailureOnce(socket, 'Client error', err);
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  // CONNECT tunnel requests arrive on the special 'connect' event and bypass
  // the Express app; answer them with the ordinary 405 + Allow contract.
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
// directly (`node server.js`). They are declared at module scope so the
// lifecycle functions can reference them, while they remain unset when the
// module is merely `require`d (e.g. by the test suite).
let hostname;
let port;
let server;

// ---------------------------------------------------------------------------
// Exit-code integrity
// ---------------------------------------------------------------------------

/**
 * Record a requested process exit code, only ever escalating upward. A
 * previously recorded failure (non-zero) is never downgraded back to success by
 * a later normal code path.
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
 * the process exits non-zero. Non-recursive because shutdown() is guarded.
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
 * the emitted URL is valid and copyable (`http://[::1]:3000/`). IPv4 addresses
 * and hostnames contain no ':' and are used verbatim, so the default line
 * remains exactly `127.0.0.1:3000`.
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
 * Start listening. The startup log line is preserved verbatim from the original
 * server; the real bound port (from server.address()) is used so the default
 * case logs exactly `http://127.0.0.1:3000/` while an ephemeral PORT=0 reports
 * the actual assigned port.
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
 * never strand the process. Idempotent - repeated signals are ignored after the
 * first. Normal signals exit 0; a recorded fatal/runtime failure exits non-zero.
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
  // without a scheduled exit. unref() ensures the timer never keeps the event
  // loop (and therefore the process) alive.
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
    // rather than leaving the process half-shut-down and still serving.
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
  // undefined state or exiting successfully after a fatal error.
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
// module (e.g. by server.test.js) nothing runs: no config load, no server, no
// listen, no process handlers - so the importing process is never mutated.
if (require.main === module) {
  main();
}

// Testability surface (see the require.main guard above). Exporting these does
// NOT change the runtime: running the file directly still auto-starts, and an
// importer must call main()/startServer()/createAndConfigureServer() explicitly.
module.exports = {
  app,
  createApp,
  createAndConfigureServer,
  handleConnect,
  errorHandler,
  loadConfiguration,
  describeError,
  sanitizeLogValue,
  formatAuthority,
  ALLOWED_METHODS,
  MAX_BODY_SIZE,
  HELLO_BODY,
  GOOD_MORNING_BODY,
  GOOD_MORNING_PATH,
};
