/**
 * Jest Configuration for Node.js HTTP Server Tests
 * 
 * This configuration file defines the test environment, file patterns,
 * coverage collection settings, and quality thresholds for the test suite.
 * 
 * @see https://jestjs.io/docs/configuration
 */

module.exports = {
  // Use Node.js test environment for server-side testing
  testEnvironment: 'node',

  // Pattern to match test files in __tests__ directory with .test.js extension
  testMatch: ['**/__tests__/**/*.test.js'],

  // Collect coverage information from server.js only
  collectCoverageFrom: [
    'server.js'
  ],

  // Enforce 100% coverage thresholds for all metrics
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    }
  },

  // Generate coverage reports in multiple formats
  coverageReporters: ['text', 'lcov', 'html'],

  // Enable verbose output for detailed test results
  verbose: true,

  // Set test timeout to 5 seconds (5000ms)
  testTimeout: 5000,

  // Clear mocks between every test for isolation
  clearMocks: true,

  // Restore mocks automatically after each test
  restoreMocks: true,

  // Run tests sequentially to avoid server sharing issues
  maxWorkers: 1,

  // Force exit after tests complete to close any open handles
  forceExit: true
};
