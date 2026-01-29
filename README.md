# Hello World Node.js Server

A simple HTTP server built with Express.js that demonstrates basic routing capabilities.

## Features

- Express.js web framework integration
- Two HTTP endpoints with different greeting messages
- Clean and maintainable code structure

## Prerequisites

- Node.js v18 or higher (tested with v20.20.0)
- npm package manager

## Installation

```bash
npm install
```

## Running the Server

Start the server using npm:

```bash
npm start
```

Or directly with Node.js:

```bash
node server.js
```

The server will start at `http://127.0.0.1:3000/`

## Available Endpoints

| Method | Path | Response | Description |
|--------|------|----------|-------------|
| GET | `/` | `Hello, World!` | Returns the classic Hello World greeting |
| GET | `/evening` | `Good evening` | Returns an evening greeting message |

## Example Usage

Using curl:

```bash
# Hello World endpoint
curl http://127.0.0.1:3000/

# Evening greeting endpoint
curl http://127.0.0.1:3000/evening
```

## Project Structure

```
.
├── server.js         # Main Express.js server implementation
├── package.json      # npm package configuration
├── package-lock.json # npm dependency lockfile
└── README.md         # This documentation file
```

## License

MIT
