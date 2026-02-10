const http = require('http');

const hostname = '127.0.0.1';
const port = 3000;

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});

/**
 * Starts the server and logs the startup notification.
 * Extracted as a function to enable testing of the startup logic.
 * @param {Function} callback - Optional callback to execute after server starts
 */
function startServer(callback) {
  server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
    if (callback) callback();
  });
}

// Only start server if this module is run directly (not required by tests)
// This conditional block is intentionally excluded from coverage as it cannot
// be executed during testing (require.main !== module when imported)
/* istanbul ignore next */
if (require.main === module) {
  startServer();
}

// Export server instance, configuration, and startup function for testing
module.exports = { server, hostname, port, startServer };
