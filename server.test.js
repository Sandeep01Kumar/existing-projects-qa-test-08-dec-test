'use strict';

/**
 * server.test.js - Tests for the Express-based HTTP server.
 *
 * The server exposes two plaintext endpoints - GET / ("Hello, World!\n") and
 * GET /good-morning ("Good morning\n") - built with Express on top of a
 * hardened Node core http.Server. Express is the project's only third-party
 * dependency; the tests drive the server as a real HTTP client and exercise its
 * exported units directly.
 *
 * Two complementary layers:
 *
 *   1. BLACK-BOX process tests - spawn the real entry point (`node server.js`)
 *      on an OS-assigned ephemeral port (PORT=0) and drive it over real HTTP
 *      and raw TCP. These exercise the public HTTP contract, framing, malformed
 *      input, timeouts, configuration, and process lifecycle exactly as an
 *      external client / operator would.
 *
 *   2. IN-PROCESS unit tests - `require('./server.js')` (its side effects are
 *      guarded behind `require.main === module`, so importing starts no server
 *      and installs no process handlers) and call the exported pure/near-pure
 *      units directly. These deterministically verify paths that a correct
 *      server never reaches over the wire - most importantly the generic-500
 *      request error boundary - which cannot be triggered black-box.
 *
 * Built-ins used:
 *   node:test, node:assert, http, net, path, child_process, os.
 *
 * Robustness / security posture of the harness itself:
 *   - Child processes receive a MINIMAL ALLOWLISTED environment (buildChildEnv):
 *     only OS essentials plus the specific HOST/PORT/SERVER_DEBUG the test sets.
 *     The parent's secrets and Node-injection variables (e.g. NODE_OPTIONS) are
 *     never forwarded (CWE-200 / CWE-526).
 *   - Child stdout/stderr are captured with hard BYTE CAPS so a noisy or looping
 *     child can never exhaust test memory (CWE-400); captured output is surfaced
 *     on every failure and asserted (no hidden warnings / stack leakage).
 *   - Every spawned child is reaped with a bounded TWO-STAGE terminator that
 *     escalates SIGTERM -> SIGKILL and FAILS if the child's exit is never
 *     observed, so no orphan can survive or hang the run.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Absolute path to the entry point under test, resolved relative to THIS file
// so the suite works no matter which directory `node --test` is invoked from.
const SERVER_ENTRY = path.join(__dirname, 'server.js');

// Loopback interface for both the server (HOST) and the client requests.
const TEST_HOST = '127.0.0.1';

// Server's MAX_BODY_SIZE (1 MiB per the AAP). The body-size guard rejects a
// body STRICTLY larger than this; exactly this many bytes is accepted.
const MAX_BODY_SIZE = 1024 * 1024;

// Bounded waits (ms). Generous enough for a cold Node start on a busy CI host,
// but finite so a stuck server surfaces as a failure rather than an infinite
// hang.
const READY_TIMEOUT_MS = 15000; // wait for the server to log readiness
const REQUEST_TIMEOUT_MS = 10000; // per HTTP request
const RAW_TIMEOUT_MS = 5000; // per raw-socket exchange
const SHUTDOWN_TIMEOUT_MS = 8000; // per stage of child termination
const TEST_TIMEOUT_MS = 20000; // per-test guard rail (fast tests)
const SLOW_HEADERS_TEST_TIMEOUT_MS = 35000; // headers-timeout elapsed-bound test
const DRAIN_MS = 250; // let async child stderr flush before asserting

// Hard cap on captured child output so a runaway child cannot exhaust memory.
const MAX_OUTPUT_BYTES = 64 * 1024;

// Exact, anchored startup line. Rejects https / arbitrary hosts and is
// bracket-aware for IPv6 authorities: `http://127.0.0.1:3000/` or
// `http://[::1]:<port>/`. Group 1 = host authority, group 2 = port.
const READY_RE = /^Server running at http:\/\/(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:]+\]):(\d+)\/$/m;

// True on POSIX, where real SIGTERM/SIGINT run the server's graceful path. On
// Windows signal delivery does not invoke JS handlers, so signal-semantics
// tests are skipped there (they still would run on POSIX/CI Linux).
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Environment isolation (TST-FINAL-05 / CWE-200 / CWE-526)
// ---------------------------------------------------------------------------

// The ONLY parent environment variables forwarded to a spawned child. These are
// OS essentials needed for Node to start and resolve paths; nothing else (no
// secrets, no NODE_OPTIONS or other Node-injection variables) is inherited.
// Compared case-insensitively because Windows environment keys vary in case.
const ENV_ALLOWLIST = new Set(
  [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'SYSTEMDRIVE',
  ].map((k) => k.toUpperCase())
);

/**
 * Build a minimal, allowlisted environment for a child process. Copies only the
 * OS-essential keys from the parent, then layers the caller's explicit
 * overrides (e.g. PORT / HOST / SERVER_DEBUG). Secrets and Node-injection
 * variables are excluded by construction (allowlist, not denylist).
 *
 * @param {Record<string,string|undefined>} overrides
 * @returns {Record<string,string>}
 */
function buildChildEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Child process management + bounded output capture
// ---------------------------------------------------------------------------

/**
 * Spawn the server entry point with a minimal allowlisted environment and
 * byte-capped stdout/stderr capture.
 *
 * @param {Record<string,string|undefined>} envOverrides
 * @returns {{ child: import('child_process').ChildProcess, getStdout: () => string, getStderr: () => string, outputTruncated: () => boolean }}
 */
function spawnServer(envOverrides) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: __dirname,
    env: buildChildEnv(envOverrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let truncated = false;
  const cap = (buf, chunk) => {
    if (buf.length >= MAX_OUTPUT_BYTES) {
      truncated = true;
      return buf;
    }
    const next = buf + chunk.toString();
    if (next.length > MAX_OUTPUT_BYTES) {
      truncated = true;
      return next.slice(0, MAX_OUTPUT_BYTES);
    }
    return next;
  };
  child.stdout.on('data', (c) => {
    stdout = cap(stdout, c);
  });
  child.stderr.on('data', (c) => {
    stderr = cap(stderr, c);
  });

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    outputTruncated: () => truncated,
  };
}

/**
 * Wait until the child logs its exact readiness line, and return the parsed
 * bound host + port. Rejects (with any captured stderr appended) if the child
 * exits early, errors, or does not become ready within `timeoutMs`. All
 * listeners and the timer are removed on settle so no handle leaks.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {() => string} getStdout
 * @param {() => string} getStderr
 * @param {number} timeoutMs
 * @returns {Promise<{host: string, port: number, line: string}>}
 */
function waitForReady(child, getStdout, getStderr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const withStderr = (msg) => {
      const detail = getStderr().trim();
      return new Error(`${msg}${detail ? `\n--- child stderr ---\n${detail}` : ''}`);
    };
    const tryMatch = () => {
      const m = getStdout().match(READY_RE);
      if (!m) return;
      const rawHost = m[1];
      const host = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost;
      done(resolve, { host, port: Number(m[2]), line: m[0] });
    };
    const onData = () => tryMatch();
    const onExit = (code, signal) =>
      done(reject, withStderr(`server exited before becoming ready (code=${code}, signal=${signal})`));
    const onError = (err) => done(reject, withStderr(`server process error: ${err.message}`));
    const timer = setTimeout(
      () => done(reject, withStderr(`timed out after ${timeoutMs}ms waiting for server readiness`)),
      timeoutMs
    );
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
    tryMatch(); // in case readiness was already logged
  });
}

/**
 * Bounded two-stage terminator (TST-FINAL-02). Requests graceful termination
 * with SIGTERM and waits for the child's `exit`; if it does not exit within one
 * SHUTDOWN_TIMEOUT_MS window it escalates to SIGKILL and waits again. Resolves
 * with the observed { code, signal }. REJECTS if the child never exits, so a
 * surviving/orphaned child fails the suite rather than passing silently.
 *
 * @param {import('child_process').ChildProcess} child
 * @returns {Promise<{code: number|null, signal: string|null}>}
 */
function terminate(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    let stage = 0;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      fn(arg);
    };
    const onExit = (code, signal) => finish(resolve, { code, signal });
    child.once('exit', onExit);

    let timer;
    const escalate = () => {
      stage += 1;
      if (stage === 1) {
        safeKill(child, 'SIGTERM');
        timer = setTimeout(escalate, SHUTDOWN_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
      } else if (stage === 2) {
        safeKill(child, 'SIGKILL');
        timer = setTimeout(escalate, SHUTDOWN_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
      } else {
        finish(reject, new Error('child did not exit after SIGTERM then SIGKILL'));
      }
    };
    escalate();
  });
}

function safeKill(child, signal) {
  try {
    child.kill(signal);
  } catch (_) {
    /* already gone */
  }
}

/**
 * Spawn the server, wait for readiness, run `fn(ctx)`, and ALWAYS reap the child
 * with the bounded two-stage terminator. Returns whatever `fn` returns.
 */
async function withServer(envOverrides, fn) {
  const ctx = spawnServer(envOverrides);
  try {
    const ready = await waitForReady(ctx.child, ctx.getStdout, ctx.getStderr, READY_TIMEOUT_MS);
    return await fn({ ...ctx, ...ready });
  } finally {
    await terminate(ctx.child);
  }
}

/**
 * Spawn a child expected to exit on its own (invalid config, bind collision),
 * and resolve with { code, signal, stdout, stderr } once it exits. Bounded so a
 * child that fails to exit rejects instead of hanging.
 */
function spawnAndWaitExit(envOverrides, timeoutMs = READY_TIMEOUT_MS) {
  const ctx = spawnServer(envOverrides);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminate(ctx.child).catch(() => {});
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    ctx.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: ctx.getStdout(), stderr: ctx.getStderr(), truncated: ctx.outputTruncated() });
    });
    ctx.child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP + raw-socket clients
// ---------------------------------------------------------------------------

/**
 * Perform a single HTTP request and resolve with `{ statusCode, headers, body }`.
 * Bounded by `timeoutMs`; each request uses its own connection (agent:false)
 * that is torn down on settle so no keep-alive socket lingers between tests. For
 * the oversized-body case the server answers 413 while the body is still
 * uploading; destroying the request then aborts the upload, and the
 * post-settlement 'error' is ignored by the single-settle guard.
 */
function httpRequest({ port, host = TEST_HOST, method = 'GET', path: reqPath = '/', body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({ host, port, method, path: reqPath, agent: false }, (res) => {
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
    });
    const timer = setTimeout(
      () => settle(reject, new Error(`request ${method} ${reqPath} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    if (typeof timer.unref === 'function') timer.unref();
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

/**
 * Send a raw payload over a bare TCP socket and resolve with the complete raw
 * response text once the server closes the connection (or after `waitMs` for a
 * still-open connection). Used where HTTP framing / parser behavior is under
 * test and a real HTTP client would hide it.
 *
 * @returns {Promise<{ raw: string, responseCount: number }>}
 */
function rawExchange(port, payload, { host = TEST_HOST, waitMs = RAW_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    const socket = net.connect(port, host, () => {
      socket.write(payload);
    });
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
      resolve({ raw, responseCount: (raw.match(/HTTP\/1\.1 /g) || []).length });
    };
    const timer = setTimeout(done, waitMs);
    if (typeof timer.unref === 'function') timer.unref();
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    socket.on('close', done);
    socket.on('error', (err) => {
      // A reset after we already have the response is fine; surface a pre-data
      // connection error only.
      if (!raw) reject(err);
      else done();
    });
  });
}

/** First line (status line) of a raw HTTP response. */
function statusLine(raw) {
  return raw.split('\r\n')[0] || '';
}

/**
 * Assert captured child stderr contains no forbidden diagnostics: no stack
 * frames (a line beginning with whitespace + "at "), and no truncation (a
 * well-behaved server never emits > MAX_OUTPUT_BYTES). This is the "safe
 * observability" gate (SRV-FINAL-02 / TST-FINAL-04) applied to output that MAY
 * legitimately contain a single-line diagnostic.
 */
function assertStderrSafe(stderr, truncated, label) {
  assert.ok(!truncated, `${label}: child output exceeded ${MAX_OUTPUT_BYTES} bytes (possible flood/leak)`);
  const stackLines = stderr.split('\n').filter((l) => /^\s+at\s/.test(l));
  assert.strictEqual(
    stackLines.length,
    0,
    `${label}: stderr must not contain stack frames (CWE-532). Got:\n${stderr}`
  );
}

/** True if the IPv6 loopback (::1) can be bound on this host. */
function ipv6LoopbackAvailable() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      probe.close(() => resolve(false));
      resolve(false);
    });
    probe.listen(0, '::1', () => {
      probe.close(() => resolve(true));
    });
  });
}

// ===========================================================================
// Black-box HTTP contract + framing (shared long-lived server)
// ===========================================================================

describe('HTTP contract and framing (spawned server)', () => {
  /** @type {ReturnType<typeof spawnServer>} */
  let ctx;
  let port;
  // How much of the shared child's stderr has already been accounted for.
  let stderrMark = 0;

  const markStderr = () => {
    stderrMark = ctx.getStderr().length;
  };
  const newStderr = () => ctx.getStderr().slice(stderrMark);
  const assertNoNewStderr = async (label) => {
    await new Promise((r) => setTimeout(r, DRAIN_MS));
    assert.strictEqual(
      newStderr().trim(),
      '',
      `${label}: expected no server diagnostics, got:\n${newStderr()}`
    );
    assert.ok(!ctx.outputTruncated(), `${label}: child output was truncated (possible flood)`);
    markStderr();
  };
  const assertNewStderrSafe = async (label, expectRe) => {
    await new Promise((r) => setTimeout(r, DRAIN_MS));
    const slice = newStderr();
    assertStderrSafe(slice, ctx.outputTruncated(), label);
    if (expectRe) {
      assert.ok(expectRe.test(slice), `${label}: expected stderr to match ${expectRe}, got:\n${slice}`);
    }
    markStderr();
  };

  before(async () => {
    ctx = spawnServer({ PORT: '0', HOST: TEST_HOST });
    const ready = await waitForReady(ctx.child, ctx.getStdout, ctx.getStderr, READY_TIMEOUT_MS);
    port = ready.port;
    assert.strictEqual(ready.host, TEST_HOST, `bound host should be ${TEST_HOST}`);
    assert.ok(Number.isInteger(port) && port > 0, `expected a bound port, got ${port}`);
    // No diagnostics should be produced merely by starting up.
    assert.strictEqual(ctx.getStderr().trim(), '', `startup produced stderr:\n${ctx.getStderr()}`);
    markStderr();
  });

  after(async () => {
    const result = await terminate(ctx.child);
    // Final safety net: nothing on stderr should ever contain a stack frame.
    assertStderrSafe(ctx.getStderr(), ctx.outputTruncated(), 'after-shutdown');
    assert.ok(result.code !== undefined, 'child exit must be observed');
  });

  // --- Preserved default endpoint: GET / ---

  it('GET / -> 200 text/plain, exact "Hello, World!\\n"', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'GET', path: '/' });
    assert.strictEqual(res.statusCode, 200);
    // Exact media type (normalized), not a permissive substring match.
    assert.strictEqual((res.headers['content-type'] || '').split(';')[0].trim(), 'text/plain');
    assert.strictEqual(res.body, 'Hello, World!\n');
    // Express's framework banner must be suppressed.
    assert.ok(!res.headers['x-powered-by'], 'X-Powered-By must be disabled');
    await assertNoNewStderr('GET /');
  });

  // --- Added endpoint: GET /good-morning ---

  it('GET /good-morning -> 200 text/plain, exact "Good morning\\n"', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'GET', path: '/good-morning' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.headers['content-type'] || '').split(';')[0].trim(), 'text/plain');
    assert.strictEqual(res.body, 'Good morning\n');
    assert.ok(!res.headers['x-powered-by'], 'X-Powered-By must be disabled');
    await assertNoNewStderr('GET /good-morning');
  });

  it('HEAD / -> 200 text/plain, empty body', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'HEAD', path: '/' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.headers['content-type'] || '').split(';')[0].trim(), 'text/plain');
    assert.strictEqual(res.body, '', 'HEAD response must have no body (RFC 9110)');
    await assertNoNewStderr('HEAD /');
  });

  it('HEAD /good-morning -> 200 text/plain, empty body', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'HEAD', path: '/good-morning' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.headers['content-type'] || '').split(';')[0].trim(), 'text/plain');
    assert.strictEqual(res.body, '', 'HEAD response must have no body (RFC 9110)');
    await assertNoNewStderr('HEAD /good-morning');
  });

  it('GET /?x=1 -> 200 (query on root is still the root route)', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'GET', path: '/?x=1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, 'Hello, World!\n');
    await assertNoNewStderr('GET /?x=1');
  });

  it('GET /good-morning?tz=utc -> 200 (query preserved on the added route)', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'GET', path: '/good-morning?tz=utc' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, 'Good morning\n');
    await assertNoNewStderr('GET /good-morning?tz=utc');
  });

  it('GET /does-not-exist -> 404 "Not Found"', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'GET', path: '/does-not-exist' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body, 'Not Found');
    await assertNoNewStderr('GET /does-not-exist');
  });

  it('GET /good-morning/extra -> 404 (added route matches its exact path only)', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'GET', path: '/good-morning/extra' });
    assert.strictEqual(res.statusCode, 404);
    await assertNoNewStderr('GET /good-morning/extra');
  });

  it('DELETE / -> 405 with exact Allow: GET, HEAD', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'DELETE', path: '/' });
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.headers['allow'], 'GET, HEAD', 'Allow header must be exact');
    assert.strictEqual(res.body, 'Method Not Allowed');
    await assertNoNewStderr('DELETE /');
  });

  it('POST /anything -> 405 (method checked before path; never 404)', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'POST', path: '/anything' });
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.headers['allow'], 'GET, HEAD');
    await assertNoNewStderr('POST /anything');
  });

  it('POST /good-morning -> 405 (method before path, even on a known route)', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'POST', path: '/good-morning' });
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.headers['allow'], 'GET, HEAD');
    await assertNoNewStderr('POST /good-morning');
  });

  it('body cap boundary: exactly 1 MiB is accepted (routes -> 405 for POST)', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    // Exactly MAX_BODY_SIZE bytes is NOT over the cap, so the body is accepted
    // and the request routes; POST is unsupported -> 405 (proves no 413 at cap).
    const res = await httpRequest({ port, method: 'POST', path: '/', body: Buffer.alloc(MAX_BODY_SIZE, 0x61) });
    assert.strictEqual(res.statusCode, 405, 'a body of exactly the cap must not be rejected as 413');
    await assertNewStderrSafe('boundary 1 MiB');
  });

  it('body cap boundary: 1 MiB + 1 byte -> 413', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'POST', path: '/', body: Buffer.alloc(MAX_BODY_SIZE + 1, 0x61) });
    assert.strictEqual(res.statusCode, 413, 'one byte over the cap must be 413');
    assert.strictEqual(res.body, 'Payload Too Large');
    await assertNewStderrSafe('boundary 1 MiB + 1');
  });

  it('oversized body (2 MiB) -> 413', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const res = await httpRequest({ port, method: 'POST', path: '/', body: Buffer.alloc(2 * 1024 * 1024, 0x61) });
    assert.strictEqual(res.statusCode, 413);
    await assertNewStderrSafe('oversized 2 MiB');
  });

  it('raw GET / -> exactly one 200 response (framing)', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const { raw, responseCount } = await rawExchange(
      port,
      'GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n'
    );
    assert.strictEqual(responseCount, 1, `expected exactly one HTTP response, got ${responseCount}:\n${raw}`);
    assert.match(statusLine(raw), /^HTTP\/1\.1 200 OK$/);
    // Framing-agnostic body assertion. Express commits a Content-Length for the
    // fixed-size greeting (the semantic GET / test already asserts the exact
    // body), so this raw check only verifies wire integrity: the Content-Type is
    // present (it carries a "; charset=utf-8" parameter, which is tolerated) and
    // the greeting is delivered exactly once.
    const headerEnd = raw.indexOf('\r\n\r\n');
    assert.ok(headerEnd !== -1, `response must have a header/body separator:\n${raw}`);
    const headerBlock = raw.slice(0, headerEnd);
    const bodyRegion = raw.slice(headerEnd + 4);
    assert.match(
      headerBlock,
      /\r\nContent-Type: text\/plain(?:;[^\r\n]*)?\r\n/,
      'Content-Type: text/plain must be on the wire'
    );
    assert.strictEqual(
      bodyRegion.split('Hello, World!\n').length - 1,
      1,
      `the greeting must appear exactly once in the body region:\n${raw}`
    );
    await assertNoNewStderr('raw GET /');
  });

  it('raw GET /good-morning -> exactly one 200 response with the greeting once', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const { raw, responseCount } = await rawExchange(
      port,
      'GET /good-morning HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n'
    );
    assert.strictEqual(responseCount, 1, `expected exactly one HTTP response, got ${responseCount}:\n${raw}`);
    assert.match(statusLine(raw), /^HTTP\/1\.1 200 OK$/);
    const headerEnd = raw.indexOf('\r\n\r\n');
    assert.ok(headerEnd !== -1, `response must have a header/body separator:\n${raw}`);
    const bodyRegion = raw.slice(headerEnd + 4);
    assert.strictEqual(
      bodyRegion.split('Good morning\n').length - 1,
      1,
      `the good-morning body must appear exactly once:\n${raw}`
    );
    await assertNoNewStderr('raw GET /good-morning');
  });

  it('two valid pipelined requests on one connection -> two 200s in order', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    // A single write carrying two COMPLETE valid requests (the second closes the
    // connection). Both must be answered, in order, over the one keep-alive
    // socket - a basic HTTP/1.1 pipelining correctness check.
    const { raw, responseCount } = await rawExchange(
      port,
      'GET / HTTP/1.1\r\nHost: test\r\n\r\nGET /good-morning HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n'
    );
    assert.strictEqual(responseCount, 2, `expected exactly two responses, got ${responseCount}:\n${raw}`);
    assert.match(statusLine(raw), /^HTTP\/1\.1 200 OK$/, `first response must be 200:\n${raw}`);
    const helloIdx = raw.indexOf('Hello, World!\n');
    const gmIdx = raw.indexOf('Good morning\n');
    assert.ok(helloIdx !== -1, `the first greeting must be delivered:\n${raw}`);
    assert.ok(gmIdx !== -1, `the second greeting must be delivered:\n${raw}`);
    assert.ok(helloIdx < gmIdx, `responses must be in request order:\n${raw}`);
    assert.strictEqual(raw.split('Hello, World!\n').length - 1, 1, 'first greeting exactly once');
    assert.strictEqual(raw.split('Good morning\n').length - 1, 1, 'second greeting exactly once');
    await assertNoNewStderr('two pipelined valid requests');
  });

  it('raw CONNECT -> exactly one 405 + Allow, then close', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const { raw, responseCount } = await rawExchange(
      port,
      'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'
    );
    assert.strictEqual(responseCount, 1, `CONNECT must yield exactly one response, got ${responseCount}:\n${raw}`);
    assert.match(statusLine(raw), /^HTTP\/1\.1 405 Method Not Allowed$/);
    assert.match(raw, /\r\nAllow: GET, HEAD\r\n/, 'CONNECT 405 must carry Allow: GET, HEAD');
    // A rejection is not an error condition, so it must not be logged.
    await assertNoNewStderr('raw CONNECT');
  });

  it('raw malformed request -> exactly one 400, safe single-line log', { timeout: TEST_TIMEOUT_MS }, async () => {
    markStderr();
    const { raw, responseCount } = await rawExchange(
      port,
      'GET / HTTP/1.1\r\nBad Header Without Colon\r\n\r\n'
    );
    assert.strictEqual(responseCount, 1, `malformed input must yield exactly one response:\n${raw}`);
    assert.match(statusLine(raw), /^HTTP\/1\.1 400 Bad Request$/);
    // A client error IS logged, but must be a single sanitized line (no stack).
    await assertNewStderrSafe('raw malformed', /Client error:/);
  });
});

// ===========================================================================
// Timeout enforcement (dedicated child)
// ===========================================================================

describe('timeout enforcement (spawned server)', () => {
  it(
    'partial headers -> 408 near the 20s headers timeout, well before the 30s request timeout',
    { timeout: SLOW_HEADERS_TEST_TIMEOUT_MS },
    async () => {
      await withServer({ PORT: '0', HOST: TEST_HOST }, async ({ port, getStderr, outputTruncated }) => {
        const started = Date.now();
        const { raw } = await rawExchange(
          port,
          // Partial headers: a request line + one header, but never the final
          // CRLF, so the server's headersTimeout must eventually fire.
          'GET / HTTP/1.1\r\nHost: slow\r\n',
          { waitMs: SLOW_HEADERS_TEST_TIMEOUT_MS - 3000 }
        );
        const elapsed = Date.now() - started;
        assert.match(statusLine(raw), /^HTTP\/1\.1 408 /, `expected a 408, got: ${statusLine(raw)}`);
        // The headers timeout is 20s. With the tightened connection-checking
        // interval it must be enforced close to 20s and clearly BEFORE the 30s
        // request timeout (previously it only fired at the ~30s scan boundary).
        assert.ok(elapsed < 28000, `408 should fire before ~28s (headers timeout), took ${elapsed}ms`);
        assert.ok(elapsed > 15000, `408 should reflect the ~20s headers bound, not fire instantly (${elapsed}ms)`);
        await new Promise((r) => setTimeout(r, DRAIN_MS));
        assertStderrSafe(getStderr(), outputTruncated(), 'slow-headers');
        assert.match(getStderr(), /Client request timeout:/, 'timeout should be logged as a single safe line');
      });
    }
  );
});

// ===========================================================================
// Timeout enforcement - dispatched slow body (in-process)
// ===========================================================================
//
// A request whose HEADERS complete (so Node dispatches the request to Express
// and body streaming begins) but whose BODY then stalls past requestTimeout
// must still be answered with a 408 AND have its socket released, rather than
// leaking the connection/FD (a slowloris-style resource-exhaustion vector).
//
// This runs IN-PROCESS via the exported createAndConfigureServer with a
// shortened requestTimeout so it drives the real 'clientError' timeout wiring
// quickly. It uses a NON-RECIPROCATING client (allowHalfOpen: true) that
// ignores the server's FIN, so it asserts BOTH that the 408 is delivered
// (FIN-first, so a slow-but-reading client still receives it) AND that the
// server ultimately destroys (releases) the socket.
describe('timeout enforcement - dispatched slow body (in-process)', () => {
  it(
    'a dispatched request whose body stalls past requestTimeout is answered 408 and the socket is released (not leaked)',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const srv = require('./server.js');
      const server = srv.createAndConfigureServer();
      // Shorten the request timeout so the incomplete-request scan fires quickly
      // while still driving the genuine 'clientError' path. The linger before
      // force-destroy is a fixed internal, so the socket is released at roughly
      // requestTimeout + linger.
      server.requestTimeout = 1500;
      server.headersTimeout = 1000;

      /** @type {import('net').Socket | undefined} */
      let serverSocket;
      server.on('connection', (s) => {
        if (!serverSocket) {
          serverSocket = s;
        }
      });

      await new Promise((resolve) => server.listen(0, TEST_HOST, resolve));
      const { port } = server.address();

      try {
        const result = await new Promise((resolve, reject) => {
          let got408 = false;
          const guard = setTimeout(() => {
            reject(
              new Error(
                `timed out waiting for the server to release the stalled socket ` +
                  `(got408=${got408}, ` +
                  `serverDestroyed=${Boolean(serverSocket && serverSocket.destroyed)})`
              )
            );
          }, TEST_TIMEOUT_MS - 3000);
          guard.unref();

          const client = net.connect(
            { port, host: TEST_HOST, allowHalfOpen: true },
            () => {
              // Complete the headers (dispatches the request -> body streaming),
              // then send only part of the promised body and stall.
              client.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n');
              client.write('0123456789');
            }
          );
          let buf = '';
          client.on('data', (d) => {
            buf += d.toString('latin1');
            if (/^HTTP\/1\.1 408\b/.test(buf)) {
              got408 = true;
            }
          });
          // A reset after the FIN (the force-destroy) is expected for this
          // non-reciprocating client; do not fail the test on it.
          client.on('error', () => {});

          // Resolve when the SERVER releases its own socket (the force-destroy,
          // or a natural close, fires 'close') - direct proof the FD is freed.
          const onServerClose = () => {
            clearTimeout(guard);
            try {
              client.destroy();
            } catch (_) {
              /* already gone */
            }
            resolve({
              got408,
              serverDestroyed: Boolean(serverSocket && serverSocket.destroyed),
            });
          };
          const attachServerClose = () => {
            if (serverSocket) {
              serverSocket.once('close', onServerClose);
            } else {
              setImmediate(attachServerClose);
            }
          };
          attachServerClose();
        });

        assert.ok(
          result.got408,
          'the stalled dispatched request must receive a 408 (delivered via FIN before release)'
        );
        assert.ok(
          result.serverDestroyed,
          'the server must destroy (release) the stalled socket, not strand it in FIN_WAIT_2'
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  );
});

// ===========================================================================
// Configuration and startup errors (dedicated children)
// ===========================================================================

describe('configuration and startup (spawned children)', () => {
  it('invalid PORT -> exit 1 with a sanitized configuration error', { timeout: TEST_TIMEOUT_MS }, async () => {
    const r = await spawnAndWaitExit({ PORT: 'abc', HOST: TEST_HOST });
    assert.strictEqual(r.code, 1, `invalid PORT should exit 1, got code=${r.code} signal=${r.signal}`);
    assert.match(r.stderr, /Configuration error: PORT/, `expected a config error, got:\n${r.stderr}`);
    assertStderrSafe(r.stderr, r.truncated, 'invalid PORT');
  });

  it('empty HOST -> exit 1 with a sanitized configuration error', { timeout: TEST_TIMEOUT_MS }, async () => {
    const r = await spawnAndWaitExit({ PORT: '0', HOST: '   ' });
    assert.strictEqual(r.code, 1, `empty HOST should exit 1, got code=${r.code} signal=${r.signal}`);
    assert.match(r.stderr, /Configuration error: HOST/, `expected a config error, got:\n${r.stderr}`);
    assertStderrSafe(r.stderr, r.truncated, 'empty HOST');
  });

  it('port bind collision -> exit 1 with a sanitized startup error (EADDRINUSE)', { timeout: TEST_TIMEOUT_MS }, async () => {
    // First server takes an ephemeral port; the second must fail to bind it.
    await withServer({ PORT: '0', HOST: TEST_HOST }, async ({ port }) => {
      const r = await spawnAndWaitExit({ PORT: String(port), HOST: TEST_HOST });
      assert.strictEqual(r.code, 1, `bind collision should exit 1, got code=${r.code} signal=${r.signal}`);
      assert.match(r.stderr, /Server startup error:/, `expected a startup error, got:\n${r.stderr}`);
      assert.match(r.stderr, /EADDRINUSE/, 'startup error should identify EADDRINUSE');
      assertStderrSafe(r.stderr, r.truncated, 'bind collision');
    });
  });

  it('IPv6 HOST=::1 -> bracketed startup URL', { timeout: TEST_TIMEOUT_MS }, async (t) => {
    if (!(await ipv6LoopbackAvailable())) {
      t.skip('IPv6 loopback (::1) not available on this host');
      return;
    }
    await withServer({ PORT: '0', HOST: '::1' }, async ({ host, port, line, getStderr, outputTruncated }) => {
      // The readiness line matched the exact, bracket-aware pattern, and the
      // parsed host is the IPv6 literal (proving the URL was `http://[::1]:.../`).
      assert.strictEqual(host, '::1', `expected bound host ::1, got ${host}`);
      assert.ok(line.includes('[::1]:'), `startup URL must bracket the IPv6 host, got: ${line}`);
      // The bracketed URL must be parseable by the WHATWG URL parser.
      const parsed = new URL(line.replace('Server running at ', ''));
      assert.strictEqual(parsed.hostname, '[::1]');
      assert.strictEqual(Number(parsed.port), port);
      assertStderrSafe(getStderr(), outputTruncated(), 'IPv6 startup');
    });
  });
});

// ===========================================================================
// Process lifecycle (POSIX signal semantics; skipped on Windows)
// ===========================================================================

describe('graceful shutdown (POSIX signals)', () => {
  const skip = IS_WINDOWS && 'POSIX signal delivery does not invoke JS handlers on Windows';

  it('SIGTERM -> graceful drain, exit 0, logs the shutdown line', { timeout: TEST_TIMEOUT_MS, skip }, async () => {
    const ctx = spawnServer({ PORT: '0', HOST: TEST_HOST });
    await waitForReady(ctx.child, ctx.getStdout, ctx.getStderr, READY_TIMEOUT_MS);
    ctx.child.kill('SIGTERM');
    const { code } = await terminate(ctx.child);
    assert.strictEqual(code, 0, 'a clean SIGTERM drain must exit 0');
    assert.match(ctx.getStdout(), /Received SIGTERM, shutting down gracefully\.\.\./);
    assertStderrSafe(ctx.getStderr(), ctx.outputTruncated(), 'SIGTERM');
  });

  it('repeated SIGINT is idempotent -> single shutdown, exit 0', { timeout: TEST_TIMEOUT_MS, skip }, async () => {
    const ctx = spawnServer({ PORT: '0', HOST: TEST_HOST });
    await waitForReady(ctx.child, ctx.getStdout, ctx.getStderr, READY_TIMEOUT_MS);
    ctx.child.kill('SIGINT');
    ctx.child.kill('SIGINT');
    const { code } = await terminate(ctx.child);
    assert.strictEqual(code, 0, 'repeated SIGINT must still exit 0');
    const shutdownLines = (ctx.getStdout().match(/shutting down gracefully/g) || []).length;
    assert.strictEqual(shutdownLines, 1, `shutdown must run once, saw ${shutdownLines}`);
    assertStderrSafe(ctx.getStderr(), ctx.outputTruncated(), 'repeated SIGINT');
  });
});

// ===========================================================================
// In-process unit + integration tests of exported units (no spawning)
// ===========================================================================

describe('unit: exported units and helpers', () => {
  // Importing is side-effect-free thanks to the require.main guard in server.js.
  const srv = require('./server.js');

  it('exports the documented testability surface', () => {
    for (const name of [
      'app', 'createApp', 'createAndConfigureServer', 'handleConnect', 'errorHandler',
      'loadConfiguration', 'describeError', 'sanitizeLogValue', 'formatAuthority',
      'ALLOWED_METHODS', 'MAX_BODY_SIZE', 'HELLO_BODY', 'GOOD_MORNING_BODY', 'GOOD_MORNING_PATH',
    ]) {
      assert.strictEqual(typeof srv[name] !== 'undefined', true, `missing export: ${name}`);
    }
    assert.deepStrictEqual(srv.ALLOWED_METHODS, ['GET', 'HEAD']);
    assert.strictEqual(srv.MAX_BODY_SIZE, MAX_BODY_SIZE);
    assert.strictEqual(srv.HELLO_BODY, 'Hello, World!\n');
    assert.strictEqual(srv.GOOD_MORNING_BODY, 'Good morning\n');
    assert.strictEqual(srv.GOOD_MORNING_PATH, '/good-morning');
    assert.strictEqual(typeof srv.app, 'function', 'app must be an Express request handler');
    assert.strictEqual(typeof srv.createApp, 'function');
  });

  it('createApp: builds a fresh, independent Express application each call', () => {
    const a = srv.createApp();
    const b = srv.createApp();
    assert.strictEqual(typeof a, 'function');
    assert.strictEqual(typeof a.use, 'function', 'app has .use()');
    assert.strictEqual(typeof a.get, 'function', 'app has .get()');
    assert.notStrictEqual(a, b, 'each call returns a distinct app instance');
  });

  it('loadConfiguration: defaults to 127.0.0.1:3000 when no env is set', () => {
    const savedHost = process.env.HOST;
    const savedPort = process.env.PORT;
    delete process.env.HOST;
    delete process.env.PORT;
    try {
      assert.deepStrictEqual(srv.loadConfiguration(), { hostname: '127.0.0.1', port: 3000 });
    } finally {
      if (savedHost === undefined) delete process.env.HOST;
      else process.env.HOST = savedHost;
      if (savedPort === undefined) delete process.env.PORT;
      else process.env.PORT = savedPort;
    }
  });

  it('loadConfiguration: honors valid HOST/PORT overrides', () => {
    const savedHost = process.env.HOST;
    const savedPort = process.env.PORT;
    process.env.HOST = '0.0.0.0';
    process.env.PORT = '8080';
    try {
      assert.deepStrictEqual(srv.loadConfiguration(), { hostname: '0.0.0.0', port: 8080 });
    } finally {
      if (savedHost === undefined) delete process.env.HOST;
      else process.env.HOST = savedHost;
      if (savedPort === undefined) delete process.env.PORT;
      else process.env.PORT = savedPort;
    }
  });

  it('describeError: single-line, sanitized, no stack by default', () => {
    const e = new Error('oops\nsecond\r\ntab\there\u0007bell');
    e.code = 'ETEST';
    const s = srv.describeError(e);
    assert.ok(!/[\r\n\t]/.test(s), 'must be a single sanitized line');
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(s), 'no control characters');
    assert.strictEqual(s, 'Error [ETEST]: oops second  tab here bell');
    // Non-Error values never have their content serialized.
    assert.strictEqual(srv.describeError({ secret: 'x' }), 'non-error value of type object');
    assert.strictEqual(srv.sanitizeLogValue('a\nb\tc'), 'a b c');
    // The default (no SERVER_DEBUG=1) must omit stacks. Only assert when this
    // test process itself has not opted in.
    if (process.env.SERVER_DEBUG !== '1') {
      assert.ok(!s.includes('\n'), 'default logging must not include a stack');
    }
  });

  it('formatAuthority: brackets IPv6, leaves IPv4/hostname verbatim', () => {
    assert.strictEqual(srv.formatAuthority('127.0.0.1', 3000), '127.0.0.1:3000');
    assert.strictEqual(srv.formatAuthority('0.0.0.0', 8080), '0.0.0.0:8080');
    assert.strictEqual(srv.formatAuthority('localhost', 80), 'localhost:80');
    assert.strictEqual(srv.formatAuthority('::1', 8080), '[::1]:8080');
    assert.strictEqual(srv.formatAuthority('fe80::1', 3000), '[fe80::1]:3000');
  });

  it('handleConnect: one 405 + Allow, then closes the socket', () => {
    const socket = {
      writable: true, destroyed: false, written: '', ended: false,
      write(d) { this.written += d; return true; },
      end(d) { if (d !== undefined) this.written += d; this.ended = true; },
      destroy() { this.destroyed = true; },
    };
    srv.handleConnect({ method: 'CONNECT' }, socket);
    assert.ok(socket.ended, 'socket must be ended (FIN)');
    assert.strictEqual((socket.written.match(/HTTP\/1\.1 /g) || []).length, 1, 'exactly one response');
    assert.match(socket.written, /^HTTP\/1\.1 405 Method Not Allowed\r\n/);
    assert.match(socket.written, /\r\nAllow: GET, HEAD\r\n/);
    assert.match(socket.written, /\r\nContent-Length: 18\r\n/);
    assert.match(socket.written, /\r\nConnection: close\r\n/);
    assert.ok(socket.written.endsWith('Method Not Allowed'));
    // An unwritable socket is destroyed, never written to, and never throws.
    const dead = { writable: false, destroyed: false, destroy() { this.destroyed = true; }, end() { throw new Error('must not write'); } };
    srv.handleConnect({}, dead);
    assert.ok(dead.destroyed);
  });

  it('errorHandler: an unexpected route throw becomes a single generic 500 (no detail leak)', { timeout: TEST_TIMEOUT_MS }, async () => {
    // Build a tiny app whose route deliberately throws, wired to the EXPORTED
    // error handler, and confirm the generic-500 contract end-to-end without a
    // detail leak. This exercises the real 500 path that a correct server never
    // reaches over the wire.
    const express = require('express');
    const boomApp = express();
    boomApp.disable('x-powered-by');
    boomApp.get('/boom', () => {
      throw new Error('boom-internal-detail');
    });
    boomApp.use(srv.errorHandler);
    const boomServer = http.createServer(boomApp);
    const origErr = console.error;
    const logs = [];
    console.error = (m) => logs.push(String(m));
    try {
      await new Promise((resolve) => boomServer.listen(0, TEST_HOST, resolve));
      const { port } = boomServer.address();
      const res = await httpRequest({ port, method: 'GET', path: '/boom' });
      assert.strictEqual(res.statusCode, 500, 'a route throw must produce a 500');
      assert.strictEqual(res.body, 'Internal Server Error');
      assert.ok(!res.body.includes('boom-internal-detail'), 'must not leak internal error detail to the client');
    } finally {
      console.error = origErr;
      await new Promise((resolve) => boomServer.close(resolve));
    }
    assert.ok(logs.length >= 1, 'the 500 must be logged');
    assert.ok(logs.every((l) => !l.includes('\n')), 'the 500 log must be single-line by default');
  });

  it('createAndConfigureServer: serves both endpoints and validation in-process (integration)', { timeout: TEST_TIMEOUT_MS }, async () => {
    const server = srv.createAndConfigureServer();
    try {
      await new Promise((resolve) => server.listen(0, TEST_HOST, resolve));
      const { port } = server.address();

      const hello = await httpRequest({ port, method: 'GET', path: '/' });
      assert.strictEqual(hello.statusCode, 200);
      assert.strictEqual(hello.body, 'Hello, World!\n');

      const gm = await httpRequest({ port, method: 'GET', path: '/good-morning' });
      assert.strictEqual(gm.statusCode, 200);
      assert.strictEqual(gm.body, 'Good morning\n');

      const notFound = await httpRequest({ port, method: 'GET', path: '/nope' });
      assert.strictEqual(notFound.statusCode, 404);
      assert.strictEqual(notFound.body, 'Not Found');

      const notAllowed = await httpRequest({ port, method: 'DELETE', path: '/' });
      assert.strictEqual(notAllowed.statusCode, 405);
      assert.strictEqual(notAllowed.headers['allow'], 'GET, HEAD');

      const tooLarge = await httpRequest({ port, method: 'POST', path: '/', body: Buffer.alloc(MAX_BODY_SIZE + 1, 0x61) });
      assert.strictEqual(tooLarge.statusCode, 413);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('buildChildEnv: forwards only allowlisted vars, never secrets or NODE_OPTIONS', () => {
    const savedSecret = process.env.BLITZY_FAKE_SECRET;
    const savedNodeOpts = process.env.NODE_OPTIONS;
    process.env.BLITZY_FAKE_SECRET = 'super-secret-value';
    process.env.NODE_OPTIONS = '--inspect';
    try {
      const env = buildChildEnv({ PORT: '0', HOST: TEST_HOST });
      assert.strictEqual(env.PORT, '0');
      assert.strictEqual(env.HOST, TEST_HOST);
      assert.ok(!('BLITZY_FAKE_SECRET' in env), 'secrets must not be forwarded');
      assert.ok(!('NODE_OPTIONS' in env), 'NODE_OPTIONS must not be forwarded');
      // Every forwarded key is on the allowlist (or an explicit override).
      const overrides = new Set(['PORT', 'HOST']);
      for (const key of Object.keys(env)) {
        assert.ok(
          ENV_ALLOWLIST.has(key.toUpperCase()) || overrides.has(key),
          `unexpected forwarded env key: ${key}`
        );
      }
    } finally {
      if (savedSecret === undefined) delete process.env.BLITZY_FAKE_SECRET;
      else process.env.BLITZY_FAKE_SECRET = savedSecret;
      if (savedNodeOpts === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = savedNodeOpts;
    }
  });
});
