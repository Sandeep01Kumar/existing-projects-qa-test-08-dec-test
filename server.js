'use strict';

/**
 * server.js - Hardened Node.js core HTTP server.
 *
 * A minimal, dependency-free HTTP server that preserves its original default
 * behavior (a valid `GET /` returns `200 text/plain "Hello, World!\n"`) while
 * adding production-grade reliability and robustness:
 *
 *   1. Error handling      - listen-error, request-handler try/catch,
 *                            req/res stream error listeners, and process-level
 *                            uncaughtException / unhandledRejection safety nets.
 *   2. Graceful shutdown   - SIGTERM / SIGINT driven drain via server.close()
 *                            with an idempotency guard and a bounded, unref'd
 *                            force-exit timer.
 *   3. Input validation    - method (405), path (404) and body-size (413)
 *                            checks with correct status codes.
 *   4. Resource cleanup    - live-socket tracking, body draining, and
 *                            deterministic connection teardown on shutdown.
 *   5. Robust processing    - request / headers / keep-alive timeouts and
 *                            malformed-request (clientError -> 400) handling.
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
// Configuration
//
// Host and port are environment-aware but default to the original values, so
// behavior is identical to the legacy server when no environment variables are
// set. All other tunables are named constants for clarity and easy auditing.
// ---------------------------------------------------------------------------
const hostname = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 3000;

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

// Only safe, side-effect-free methods are served by this endpoint.
const ALLOWED_METHODS = ['GET', 'HEAD'];

// ---------------------------------------------------------------------------
// Module-level runtime state
// ---------------------------------------------------------------------------

// Registry of live sockets, used for deterministic teardown on shutdown.
const sockets = new Set();

// Guard that makes shutdown() idempotent so repeated signals never double-run.
let isShuttingDown = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emit a generic 500 response for an unexpected server-side error without
 * leaking internal details to the client. If the response has already begun,
 * the underlying stream is destroyed instead (headers cannot be rewritten).
 *
 * @param {http.ServerResponse} res
 * @param {Error} err
 */
function sendServerError(res, err) {
  console.error('Unhandled error while processing request:', err);
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  } else {
    res.destroy();
  }
}

// ---------------------------------------------------------------------------
// Request routing
//
// Routing decisions are made only after the request body has been safely
// consumed (see handleRequest). Order of checks: method -> path -> fast path.
// ---------------------------------------------------------------------------

/**
 * Validate and route a fully-received request.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function routeRequest(req, res) {
  // Input validation: reject unsupported methods with 405.
  if (!ALLOWED_METHODS.includes(req.method)) {
    res.writeHead(405, {
      'Content-Type': 'text/plain',
      Allow: ALLOWED_METHODS.join(', '),
    });
    res.end('Method Not Allowed');
    return;
  }

  // Input validation: only the root path is served. A query string such as
  // "/?x=1" still resolves to the root "/"; anything else is 404.
  const pathname = (req.url || '/').split('?')[0];
  if (pathname !== '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  // Preserved default behavior - the backward-compatible fast path.
  // A valid GET / returns exactly: 200, Content-Type: text/plain, body
  // "Hello, World!\n". HEAD returns the same status/headers with no body
  // per RFC 9110 (a message body must not be sent in a response to HEAD).
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end('Hello, World!\n');
  }
}

// ---------------------------------------------------------------------------
// Request handler
//
// Attaches stream error listeners, enforces the body-size cap as data streams
// in (never buffering unbounded data), and routes the request only once its
// body has been fully and safely consumed.
// ---------------------------------------------------------------------------

/**
 * Top-level request handler wired into http.createServer.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function handleRequest(req, res) {
  // Stream error listeners prevent an unhandled req/res error (e.g. a client
  // that aborts mid-flight) from crashing the process.
  req.on('error', (err) => {
    console.error('Request stream error:', err);
    if (!res.headersSent) {
      // A malformed / interrupted request maps to 400. Guard the write so a
      // teardown race can never itself throw.
      try {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
      } catch (_writeErr) {
        res.destroy();
      }
    } else {
      res.destroy();
    }
  });

  res.on('error', (err) => {
    console.error('Response stream error:', err);
    res.destroy();
  });

  try {
    // Body-size enforcement (cross-cutting DoS guard). Bytes are counted as
    // they arrive and the request is rejected the moment the cap is exceeded,
    // before any unbounded buffering. Attaching a 'data' listener also drains
    // the body so keep-alive sockets are released cleanly.
    let received = 0;
    let limitExceeded = false;

    req.on('data', (chunk) => {
      if (limitExceeded) {
        return;
      }
      received += chunk.length;
      if (received > MAX_BODY_SIZE) {
        limitExceeded = true;
        if (!res.headersSent) {
          // Signal that the connection is being abandoned (we stop reading the
          // oversized body) so keep-alive clients do not try to reuse a socket
          // that is about to be torn down.
          res.writeHead(413, {
            'Content-Type': 'text/plain',
            Connection: 'close',
          });
          res.end('Payload Too Large');
        }
        // Stop reading any further body from an oversized request.
        req.destroy();
      }
    });

    // The body has been fully and safely consumed: route the request. The
    // handler body is wrapped in try/catch so an unexpected throw becomes a
    // controlled 500 rather than an uncaught exception.
    req.on('end', () => {
      if (limitExceeded) {
        return;
      }
      try {
        routeRequest(req, res);
      } catch (err) {
        sendServerError(res, err);
      }
    });
  } catch (err) {
    // Defensive: any synchronous failure during listener setup also yields a
    // controlled 500.
    sendServerError(res, err);
  }
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------
const server = http.createServer(handleRequest);

// Robust-processing timeouts guard against slow or stalled clients.
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;

// Listen-error handling: a bind failure (EADDRINUSE, EACCES, ...) is logged
// and exits non-zero instead of crashing with an unhandled 'error' event.
server.on('error', (err) => {
  console.error(`Server error (${err.code || 'UNKNOWN'}): ${err.message}`);
  process.exit(1);
});

// Malformed-request handling: reply 400 to clients that send an unparseable
// request, then let the socket close. Skip already-reset / unwritable sockets.
server.on('clientError', (err, socket) => {
  console.error('Client error:', err.message);
  if (err.code === 'ECONNRESET' || !socket.writable) {
    return;
  }
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// Connection tracking (resource cleanup): remember every live socket and
// forget it once closed, so shutdown can tear down stragglers deterministically.
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => {
    sockets.delete(socket);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start listening. The startup log line is preserved verbatim from the
 * original server for backward compatibility.
 */
function startServer() {
  server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
  });
}

/**
 * Graceful shutdown: stop accepting new connections, drain in-flight requests,
 * and exit 0 when drained. A bounded, unref'd timer forces exit if draining
 * stalls. Idempotent - repeated signals are ignored after the first.
 *
 * @param {string} signal - The signal or reason that triggered the shutdown.
 */
function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`Received ${signal}, shutting down gracefully...`);

  // Release idle keep-alive connections so server.close() can complete
  // promptly. Guarded by typeof for portability across Node versions
  // (closeIdleConnections is available on Node 18.2+).
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }

  // Stop accepting new connections and exit once in-flight requests drain.
  server.close(() => {
    process.exit(0);
  });

  // Bounded force-exit: if connections do not drain within the timeout, tear
  // them down and exit non-zero. The timer is unref'd so it never keeps the
  // event loop (and therefore the process) alive on its own.
  const forceTimer = setTimeout(() => {
    console.error('Forced shutdown: connections did not drain in time.');
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    sockets.forEach((socket) => socket.destroy());
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();
}

// ---------------------------------------------------------------------------
// Process-level safety nets + signal registration
// ---------------------------------------------------------------------------
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Last-resort safety nets: log the fault and shut down gracefully rather than
// leaving the process in an undefined state.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  shutdown('unhandledRejection');
});

// ---------------------------------------------------------------------------
// Entry point - auto-start so `node server.js` continues to run the server.
// ---------------------------------------------------------------------------
startServer();
