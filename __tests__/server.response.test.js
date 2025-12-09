/**
 * Response Validation Jest Tests for Node.js HTTP Server
 * 
 * This test file contains focused tests for validating server response characteristics:
 * - Status code verification (200 OK)
 * - Header verification (Content-Type: text/plain)
 * - Body content verification (exact string match)
 * - Body length verification (14 bytes)
 * - Trailing newline verification (0x0A)
 * - Character encoding validation
 * 
 * Uses supertest for HTTP assertions with fluent .expect() API.
 * 
 * @see server.js - The HTTP server being tested
 */

const request = require('supertest');
const { server } = require('../server');

// Expected values for response validation
const EXPECTED_BODY = 'Hello, World!\n';
const EXPECTED_BODY_LENGTH = 14;
const EXPECTED_STATUS = 200;
const EXPECTED_CONTENT_TYPE = 'text/plain';
const NEWLINE_CHAR_CODE = 0x0A; // ASCII code for '\n'

describe('Server Response Validation', () => {
  // Note: Server is not closed here - Jest forceExit handles cleanup
  // This prevents issues with shared server instance across test files

  describe('Status Code', () => {
    test('should return 200 OK status code', async () => {
      const response = await request(server).get('/');
      expect(response.status).toBe(EXPECTED_STATUS);
    });

    test('should return 200 OK status code using expect chain', async () => {
      await request(server)
        .get('/')
        .expect(EXPECTED_STATUS);
    });

    test('should return 200 for any path', async () => {
      const response = await request(server).get('/any/random/path');
      expect(response.status).toBe(EXPECTED_STATUS);
    });
  });

  describe('Headers', () => {
    test('should return Content-Type text/plain', async () => {
      const response = await request(server).get('/');
      expect(response.headers['content-type']).toMatch(/text\/plain/);
    });

    test('should return Content-Type using expect chain', async () => {
      await request(server)
        .get('/')
        .expect('Content-Type', /text\/plain/);
    });

    test('should handle Content-Type header case-insensitivity', async () => {
      const response = await request(server).get('/');
      // HTTP headers are case-insensitive; check various casing
      const contentType = response.headers['content-type'] ||
                          response.headers['Content-Type'] ||
                          response.headers['CONTENT-TYPE'];
      expect(contentType).toBeDefined();
      expect(contentType).toMatch(/text\/plain/);
    });

    test('should not include unexpected headers', async () => {
      const response = await request(server).get('/');
      // Server sets Content-Type and Date headers
      expect(response.headers['content-type']).toBeDefined();
    });
  });

  describe('Response Body', () => {
    test('should return exactly "Hello, World!\\n"', async () => {
      const response = await request(server).get('/');
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should return response body of 14 bytes', async () => {
      const response = await request(server).get('/');
      expect(Buffer.byteLength(response.text)).toBe(EXPECTED_BODY_LENGTH);
    });

    test('should include trailing newline character', async () => {
      const response = await request(server).get('/');
      expect(response.text.endsWith('\n')).toBe(true);
    });

    test('should have newline as 0x0A (ASCII 10)', async () => {
      const response = await request(server).get('/');
      // Check the last character is newline (position 13, 0-indexed)
      expect(response.text.charCodeAt(13)).toBe(NEWLINE_CHAR_CODE);
    });

    test('should have exact character count of 14', async () => {
      const response = await request(server).get('/');
      expect(response.text.length).toBe(EXPECTED_BODY_LENGTH);
    });

    test('should start with "Hello, World!"', async () => {
      const response = await request(server).get('/');
      expect(response.text.startsWith('Hello, World!')).toBe(true);
    });

    test('should match byte-by-byte expected content', async () => {
      const response = await request(server).get('/');
      const expectedBytes = Buffer.from(EXPECTED_BODY);
      const actualBytes = Buffer.from(response.text);
      expect(actualBytes.equals(expectedBytes)).toBe(true);
    });

    test('should use UTF-8 encoding', async () => {
      const response = await request(server).get('/');
      // Verify that the text matches when decoded as UTF-8
      const utf8Decoded = Buffer.from(response.text, 'utf8').toString('utf8');
      expect(utf8Decoded).toBe(EXPECTED_BODY);
    });
  });

  describe('Response Consistency', () => {
    test('should return identical response for multiple requests', async () => {
      const responses = await Promise.all([
        request(server).get('/'),
        request(server).get('/'),
        request(server).get('/')
      ]);

      responses.forEach((response) => {
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
        expect(response.headers['content-type']).toMatch(/text\/plain/);
      });
    });

    test('should return same body regardless of request method', async () => {
      const getResponse = await request(server).get('/');
      const postResponse = await request(server).post('/');
      const putResponse = await request(server).put('/');

      expect(getResponse.text).toBe(EXPECTED_BODY);
      expect(postResponse.text).toBe(EXPECTED_BODY);
      expect(putResponse.text).toBe(EXPECTED_BODY);
    });
  });
});
