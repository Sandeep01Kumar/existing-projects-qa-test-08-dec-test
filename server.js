/**
 * Express.js Web Server
 * 
 * This server provides two HTTP endpoints:
 * - GET / : Returns "Hello, World!" greeting
 * - GET /evening : Returns "Good evening" greeting
 * 
 * Refactored from built-in http module to Express.js framework
 * for improved routing capabilities and cleaner code structure.
 */

const express = require('express');

// Create Express application instance
const app = express();

// Server configuration - maintain port 3000 for backward compatibility
const port = 3000;

/**
 * Root endpoint handler
 * Returns the classic "Hello, World!" greeting
 * 
 * @route GET /
 * @returns {string} "Hello, World!\n" - Plain text response with trailing newline for backward compatibility
 */
app.get('/', (req, res) => {
  res.send('Hello, World!\n');
});

/**
 * Evening greeting endpoint handler
 * Returns a "Good evening" greeting message
 * 
 * @route GET /evening
 * @returns {string} "Good evening" - Plain text response
 */
app.get('/evening', (req, res) => {
  res.send('Good evening');
});

/**
 * Start the Express server
 * Listens on configured port and logs startup message to console
 */
app.listen(port, () => {
  console.log(`Server running at http://127.0.0.1:${port}/`);
});
