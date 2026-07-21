# hello_world

A minimal, **dependency-free** HTTP server built on the Node.js core `http`
module. This project is created for QA testing.

The server preserves its original default behavior — a valid `GET /` returns
`200` with `Content-Type: text/plain` and the body `Hello, World!\n` — while
adding production-grade error handling, graceful shutdown, input validation,
resource cleanup, and robust request processing.

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
$ curl http://127.0.0.1:3000/
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
| `NODE_ENV` | *(unset)*   | When set to `production`, error logs omit stack traces.                                      |

Example — bind all interfaces on port `8080`:

```bash
PORT=8080 HOST=0.0.0.0 node server.js
```

> **Windows PowerShell:** set the variables first, then run the server:
>
> ```powershell
> $env:PORT = "8080"; $env:HOST = "0.0.0.0"; node server.js
> ```

## HTTP behavior / status codes

Only the root path `/` is served, and only the safe methods `GET` and `HEAD`
are accepted. Every other request class receives an appropriate status code.

| Status                      | When                                                                     |
|-----------------------------|--------------------------------------------------------------------------|
| `200 OK`                    | `GET /` (returns `Hello, World!\n`) or `HEAD /` (same headers, no body). |
| `400 Bad Request`           | A malformed request line/headers or an interrupted request.              |
| `404 Not Found`             | Any path other than `/`.                                                 |
| `405 Method Not Allowed`    | Any method other than `GET`/`HEAD` (the response includes an `Allow` header). |
| `408 Request Timeout`       | The client is too slow to send its request or headers.                   |
| `413 Payload Too Large`     | The request body exceeds the 1 MiB size cap.                             |
| `500 Internal Server Error` | An unexpected server-side error occurred while handling the request.     |

To resist slow-client and denial-of-service patterns, request processing is
bounded by a request timeout (30s), a headers timeout (20s), and a keep-alive
timeout (5s), together with the 1 MiB request-body cap noted above.

## Graceful shutdown

The server listens for `SIGTERM` and `SIGINT` (Ctrl+C). On the first signal it:

1. Logs `Received <signal>, shutting down gracefully...`.
2. Stops accepting new connections and drains in-flight requests via
   `server.close()`.
3. Exits with code `0` once all connections have drained.

If draining does not complete within roughly 10 seconds, any remaining
connections are force-closed and the process exits with a non-zero code.
Repeated signals are safely ignored — shutdown is idempotent.

## Testing

The smoke tests use only Node.js built-ins (`node:test` and `node:assert`) and
live in `server.test.js`. Run them with:

```bash
npm test
```

which is equivalent to:

```bash
node --test
```
