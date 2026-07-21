'use strict';

/**
 * server.test.js - Node core smoke tests for the hardened HTTP server.
 *
 * These tests validate `server.js` as a BLACK BOX. Because `server.js`
 * auto-starts on execution and exports nothing, the suite spawns it as a child
 * process (`node server.js`) on an OS-assigned ephemeral port (PORT=0) so it
 * can never collide with a real instance on the default :3000 (nor with any
 * sibling clone running in parallel), then drives the running server over real
 * HTTP.
 *
 * Zero third-party dependencies - only Node.js built-ins are used, matching the
 * project's deliberate zero-dependency posture (AAP 0.6 / 0.8.1):
 *   - node:test      test runner + lifecycle hooks (describe / it / before / after)
 *   - node:assert    assertions
 *   - http           HTTP client used to exercise the server
 *   - child_process  spawn the server entry point under test
 *   - path           resolve the entry point relative to this file
 *
 * Coverage (all against the spawned server on 127.0.0.1:<ephemeral>):
 *   - 200 fast path : GET /             -> 200, text/plain, body "Hello, World!\n"
 *   - 405           : DELETE /          -> 405 (unsupported method)
 *   - 404           : GET /does-not-exist -> 404 (unknown path)
 *   - 413           : POST / (2 MiB)    -> 413 (body exceeds MAX_BODY_SIZE)
 *
 * Robustness: every network operation and the readiness wait are bounded by
 * timeouts so a hung server fails the test instead of hanging the run, and the
 * spawned child is unconditionally terminated in the `after` hook so no orphan
 * process is ever left bound to the test port.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// Absolute path to the entry point under test, resolved relative to THIS file
// so the suite works no matter which directory `node --test` is invoked from.
const SERVER_ENTRY = path.join(__dirname, 'server.js');

// Loopback interface for both the server (HOST) and the client requests.
const TEST_HOST = '127.0.0.1';

// Body used to exceed the server's MAX_BODY_SIZE (1 MiB per the AAP). 2 MiB is
// comfortably over the cap, so the server's body-size guard reliably rejects it
// with 413 while it is still streaming in.
const OVERSIZED_BODY = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2 MiB of 'a'

// Bounded waits (ms). Generous enough for a cold Node start on a busy CI host,
// but finite so a stuck server surfaces as a failure rather than an infinite
// hang.
const READY_TIMEOUT_MS = 15000; // wait for the server to log readiness
const REQUEST_TIMEOUT_MS = 10000; // per HTTP request
const SHUTDOWN_TIMEOUT_MS = 8000; // wait for the child to exit in `after`
const TEST_TIMEOUT_MS = 20000; // per-test guard rail

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait until the spawned server logs its readiness line, and return the actual
 * bound TCP port parsed from that line. Because the server is started with
 * PORT=0, the real (OS-assigned) port is only knowable from the startup log:
 *
 *   "Server running at http://127.0.0.1:<port>/"
 *
 * Rejects if the child exits early, emits an error, or fails to become ready
 * within `timeoutMs`. All listeners and the timer are cleaned up on settle so
 * this helper leaves no dangling handles.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<number>} the actual bound TCP port
 */
function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const succeed = (port) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(port);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      stdout += chunk.toString();
      // Match the preserved startup line and capture the real bound port.
      const match = stdout.match(/Server running at https?:\/\/[^:/]+:(\d+)\//);
      if (match) succeed(Number(match[1]));
    };
    const onExit = (code, signal) =>
      fail(new Error(`server exited before becoming ready (code=${code}, signal=${signal})`));
    const onError = (err) => fail(err);

    const timer = setTimeout(
      () => fail(new Error(`timed out after ${timeoutMs}ms waiting for server readiness`)),
      timeoutMs
    );
    // Never let the readiness timer itself keep the event loop alive.
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/**
 * Perform a single HTTP request against the server under test and resolve with
 * a plain result object `{ statusCode, headers, body }`. Keeps the individual
 * tests DRY.
 *
 * The call is bounded by `timeoutMs`; on timeout (or any socket error) the
 * promise rejects and the underlying request is destroyed. The client socket is
 * always torn down once the response has been read (agent:false + an explicit
 * destroy on settle), so no keep-alive connection lingers between tests. For
 * the oversized-body case the server answers 413 while the request body is
 * still uploading; destroying the client request then aborts the remaining
 * upload, which the hardened server handles cleanly, and the post-settlement
 * 'error' is ignored by the single-settle guard.
 *
 * @param {object} opts
 * @param {number} opts.port                 - bound port of the server under test
 * @param {string} [opts.method='GET']       - HTTP method
 * @param {string} [opts.path='/']           - request target
 * @param {Buffer|string} [opts.body]        - optional request body
 * @param {number} [opts.timeoutMs]          - per-request timeout
 * @returns {Promise<{statusCode:number, headers:import('http').IncomingHttpHeaders, body:string}>}
 */
function httpRequest({ port, method = 'GET', path: reqPath = '/', body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;

    // `agent:false` gives each request its own connection that is closed after
    // the response, so tests never share or leak a keep-alive socket.
    const req = http.request(
      { host: TEST_HOST, port, method, path: reqPath, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          settle(resolve, {
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', (err) => settle(reject, err));
      }
    );

    const timer = setTimeout(
      () => settle(reject, new Error(`request ${method} ${reqPath} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    if (typeof timer.unref === 'function') timer.unref();

    /**
     * Settle the promise exactly once, clearing the timeout and tearing down the
     * client request/socket. Any 'error' that results from destroying an
     * in-flight request after settlement is intentionally ignored.
     */
    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      fn(value);
    }

    req.on('error', (err) => settle(reject, err));

    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('server.js hardened HTTP server smoke tests', () => {
  /** @type {import('child_process').ChildProcess} */
  let child;
  /** @type {number} */
  let port;
  let stderr = '';

  before(async () => {
    // Spawn the real entry point. PORT=0 asks the OS for a free ephemeral port
    // (never collides with :3000 or a sibling clone); HOST binds loopback. The
    // rest of the parent environment is preserved. cwd is pinned to this file's
    // directory so `server.js` resolves regardless of the caller's cwd.
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: __dirname,
      env: { ...process.env, PORT: '0', HOST: TEST_HOST },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Drain stderr so it cannot exert backpressure on the child, and retain it
    // for diagnostics if startup fails.
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    try {
      port = await waitForReady(child, READY_TIMEOUT_MS);
    } catch (err) {
      // Surface any captured stderr to make a startup failure debuggable.
      const detail = stderr.trim();
      throw new Error(`${err.message}${detail ? `\n--- server stderr ---\n${detail}` : ''}`);
    }

    assert.ok(Number.isInteger(port) && port > 0, `expected a bound port, got ${port}`);
  });

  after(async () => {
    // Always terminate the child so no orphan server is left bound to the port,
    // even if a test threw. If it has already exited there is nothing to do.
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };

      child.once('exit', finish);

      // Escalate to a forceful kill if graceful termination does not complete in
      // time, then resolve regardless so a shutdown quirk never hangs the run.
      // (On Windows the graceful SIGTERM path may not execute; the child is
      // still terminated and 'exit' fires, which is all this cleanup requires.)
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {
          /* already gone */
        }
        finish();
      }, SHUTDOWN_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();

      // Request the server's graceful shutdown path where the platform supports
      // it; on platforms that do not, this still terminates the child.
      try {
        child.kill('SIGTERM');
      } catch (_) {
        finish();
      }
    });
  });

  it('returns 200 text/plain "Hello, World!\\n" for GET /', { timeout: TEST_TIMEOUT_MS }, async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/' });

    assert.strictEqual(res.statusCode, 200, 'GET / should return 200');
    assert.ok(
      typeof res.headers['content-type'] === 'string' && res.headers['content-type'].includes('text/plain'),
      `expected content-type to include text/plain, got ${res.headers['content-type']}`
    );
    assert.strictEqual(res.body, 'Hello, World!\n', 'GET / body should be the preserved greeting');
  });

  it('returns 405 for an unsupported method (DELETE /)', { timeout: TEST_TIMEOUT_MS }, async () => {
    const res = await httpRequest({ port, method: 'DELETE', path: '/' });

    assert.strictEqual(res.statusCode, 405, 'DELETE / should return 405 Method Not Allowed');
  });

  it('returns 404 for an unknown path (GET /does-not-exist)', { timeout: TEST_TIMEOUT_MS }, async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/does-not-exist' });

    assert.strictEqual(res.statusCode, 404, 'unknown path should return 404 Not Found');
  });

  it('returns 413 for an oversized request body (POST / with 2 MiB)', { timeout: TEST_TIMEOUT_MS }, async () => {
    const res = await httpRequest({ port, method: 'POST', path: '/', body: OVERSIZED_BODY });

    assert.strictEqual(res.statusCode, 413, 'oversized body should return 413 Payload Too Large');
  });
});
