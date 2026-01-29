# Hello World Express Server

A simple Node.js HTTP server built with Express.js that demonstrates basic routing with multiple endpoints.

> **Note:** This project was originally created for backprop integration testing (hao-backprop-test).

## Description

This is a tutorial project showcasing a Node.js server using the Express.js web framework. The server hosts two HTTP endpoints:
- A root endpoint that returns "Hello, World!"
- An evening endpoint that returns "Good evening"

## Prerequisites

- Node.js v18 or higher (required for Express.js 5.x)
- npm (Node Package Manager)

## Installation

Clone the repository and install the dependencies:

```bash
npm install
```

This will install Express.js and all required dependencies.

## Running the Server

Start the server using one of the following commands:

```bash
# Using npm start script
npm start

# Or directly with Node.js
node server.js
```

The server will start and display:
```
Server running at http://127.0.0.1:3000/
```

## Available Endpoints

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| GET | `/` | Root endpoint | `Hello, World!` |
| GET | `/evening` | Evening greeting endpoint | `Good evening` |

### Example Usage

Once the server is running, you can test the endpoints using curl or your browser:

```bash
# Test the root endpoint
curl http://127.0.0.1:3000/
# Response: Hello, World!

# Test the evening endpoint
curl http://127.0.0.1:3000/evening
# Response: Good evening
```

## Project Structure

```
.
├── server.js          # Main Express.js server implementation
├── package.json       # Node.js project manifest with dependencies
├── package-lock.json  # Dependency lockfile
└── README.md          # This documentation file
```

## Dependencies

- **express** (^5.2.1) - Fast, unopinionated, minimalist web framework for Node.js

## Configuration

The server runs with the following default configuration:

| Setting | Value |
|---------|-------|
| Host | 127.0.0.1 |
| Port | 3000 |

## License

MIT
