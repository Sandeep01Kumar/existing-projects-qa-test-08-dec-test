# hello_world

A minimal, **dependency-free** HTTP server built on the Node.js core `http`
module. This project is created for QA testing.

The server preserves its original default behavior — a valid `GET /` returns
`200` with `Content-Type: text/plain` and the body `Hello, World!\n` — while
adding a specific set of reliability and robustness features: per-request and
process-level error handling (the entire request callback — handler setup, body
streaming, and routing — is guarded so that any unexpected error becomes a
single generic `500` while the response is still writable, alongside `req`/`res`
stream-error listeners, listen-error classification, and
`uncaughtException`/`unhandledRejection` safety nets), signal-driven graceful
shutdown with a bounded force-exit, request validation (allowed methods, path,
and a request-body size cap), live-connection tracking and cleanup, and
slow-client/DoS-resistant request, headers, and keep-alive timeouts. This is a
plaintext HTTP service and intentionally provides **no** TLS, authentication,
or authorization.

## Requirements

- [Node.js](https://nodejs.org/) `>= 18`.

There are **no third-party dependencies** — nothing needs to be installed. A
Node.js runtime is the only prerequisite.

## Running the server

Start the server directly:

```bash
node server.js
```

Or via the npm script:

```bash
npm start
```

By default it listens on `http://127.0.0.1:3000/` and logs its startup line:

```text
Server running at http://127.0.0.1:3000/
```

A request to the root path returns `200` with a `text/plain` body:

```bash
curl http://127.0.0.1:3000/
```

Expected output:

```text
Hello, World!
```

## Configuration (environment variables)

The bind address is configurable via environment variables and defaults to the
loopback interface, so behavior is unchanged when nothing is set. Invalid
values are rejected at startup with a non-zero exit code rather than being
silently coerced.

| Variable   | Default     | Description                                                                                  |
|------------|-------------|----------------------------------------------------------------------------------------------|
| `PORT`     | `3000`      | TCP port to listen on. Must be an integer in `0`–`65535` (`0` requests an ephemeral OS port). |
| `HOST`     | `127.0.0.1` | Host / interface to bind. Must be a non-empty string.                                        |
| `SERVER_DEBUG` | *(unset)* | Diagnostic opt-in. Error logs are single-line and sanitized (no stack traces) by default in **every** environment; set to `1` to additionally include stack traces when debugging locally. |

Example — bind all interfaces on port `8080`:

```bash
PORT=8080 HOST=0.0.0.0 node server.js
```

> **Windows PowerShell:** set the variables first, then run the server:
>
> ```powershell
> $env:PORT = "8080"; $env:HOST = "0.0.0.0"; node server.js
> ```

> ⚠️ **Exposure warning:** binding `0.0.0.0` makes the server listen on **all**
> network interfaces, so this plaintext, unauthenticated service can become
> reachable from other hosts wherever network and firewall policy permit. Retain
> the default `127.0.0.1` (loopback only) unless remote access is intentional
> and appropriately restricted — for example behind a firewall, on a private
> network, or fronted by an authenticating reverse proxy.

## HTTP behavior / status codes

Only the root path `/` is served, and only the safe methods `GET` and `HEAD`
are accepted.

**Validation precedence.** Checks are applied in a fixed order — **body-size
cap → method → path** — and the first failing check determines the status:

1. **Body size** is enforced as the request streams in: a body exceeding the
   1 MiB cap returns `413` regardless of method or path (before any routing).
2. **Method** is checked next: any method other than `GET`/`HEAD` returns `405`
   on **any** path. Because method is checked before path, `POST /` and
   `POST /anything` both return `405` — never `404`.
3. **Path** is checked last: for an allowed method, any path other than `/`
   returns `404`. A query string on the root (for example `/?x=1`) still
   resolves to `/` and is served normally.

| Status                      | When                                                                                          |
|-----------------------------|-----------------------------------------------------------------------------------------------|
| `200 OK`                    | `GET /` returns `Content-Type: text/plain` and the body `Hello, World!\n`. `HEAD /` returns the same `200` status and `Content-Type: text/plain` **with no body**; other generated headers may differ (for example `GET` responses are sent with `Transfer-Encoding: chunked`, which `HEAD` does not carry). A query string on `/` (e.g. `/?x=1`) is still the root route. |
| `400 Bad Request`           | A malformed request line or headers, **while the connection is still writable**. A client that has already disconnected or reset the socket may simply be closed without a response being written. |
| `404 Not Found`             | An allowed method (`GET`/`HEAD`) on any path other than `/`.                                   |
| `405 Method Not Allowed`    | Any method other than `GET`/`HEAD`, on any path (the response includes an `Allow: GET, HEAD` header). Method is validated before path. This includes the `CONNECT` tunneling method: although HTTP surfaces `CONNECT` through a separate protocol event rather than the normal request handler, the server answers it with the same `405` + `Allow: GET, HEAD` and then closes the connection, so **no** method escapes validation. |
| `408 Request Timeout`       | The client is too slow to send its request or headers, while the connection is still writable. |
| `413 Payload Too Large`     | The request body exceeds the 1 MiB size cap (enforced before routing).                        |
| `500 Internal Server Error` | An unexpected server-side error occurred while handling the request.                          |

To resist slow-client and denial-of-service patterns, request processing is
bounded by a request timeout (30s), a headers timeout (20s), and a keep-alive
timeout (5s), together with the 1 MiB request-body cap noted above. These
timeouts are enforced promptly: the server configures a short
connection-checking interval so a stalled request or incomplete headers are cut
off close to their configured limits — for example, partial headers yield a
`408` near the 20s headers timeout — rather than only at Node's default ~30s
connection-scan boundary.

## Graceful shutdown

The server listens for `SIGTERM` and `SIGINT` (Ctrl+C). On the first signal it:

1. Logs `Received <signal>, shutting down gracefully...`.
2. Stops accepting new connections and drains in-flight requests via
   `server.close()`.
3. Exits with code `0` once all connections have drained.

Repeated signals are safely ignored — shutdown is idempotent.

### Exit codes

The process exit code reflects how it terminated:

| Situation                                                                | Exit code      |
|--------------------------------------------------------------------------|----------------|
| Normal `SIGINT`/`SIGTERM` shutdown that drains cleanly                    | `0`            |
| Drain does not finish within ~10 s (remaining connections are force-closed) | non-zero (`1`) |
| Fatal runtime fault (`uncaughtException` / `unhandledRejection`) or a runtime server error | non-zero (`1`) |
| Invalid `HOST` / `PORT` configuration — rejected before listening         | `1`            |
| Bind failure such as `EADDRINUSE` / `EACCES` — before the server is live   | `1`           |

Invalid configuration and bind failures happen before the server begins
listening, so they exit `1` immediately with no drain (there is nothing to
drain). A fatal runtime fault records a non-zero exit code and then still runs
the graceful drain before the process exits.

## Testing

The tests use only Node.js built-ins (`node:test`, `node:assert`, `http`,
`net`, and other core modules — no third-party packages) and live in
`server.test.js`. They cover the HTTP contract and framing, malformed input,
timeout enforcement, configuration and startup failures, process lifecycle, and
the exported handlers directly. Run them with:

```bash
npm test
```

which is equivalent to:

```bash
node --test
```
