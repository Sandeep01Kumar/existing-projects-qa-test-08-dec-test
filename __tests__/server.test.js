/**
 * Main Comprehensive Jest Test Suite for Node.js HTTP Server
 * 
 * This test file provides comprehensive coverage for the HTTP server including:
 * - HTTP response validation (status codes, headers, body)
 * - HTTP method tests (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS)
 * - URL path tests (root, arbitrary, nested, query params)
 * - Combined request validation
 * 
 * Uses supertest for HTTP assertions with the fluent .expect() API.
 * 
 * @see server.js - The HTTP server being tested
 */

const request = require('supertest');
const { server } = require('../server');

// Test constants matching server.js behavior
const EXPECTED_BODY = 'Hello, World!\n';
const EXPECTED_STATUS = 200;
const EXPECTED_CONTENT_TYPE = 'text/plain';

describe('HTTP Server', () => {
  /**
   * Close the server after all tests complete to ensure clean shutdown
   * and prevent open handle warnings in Jest
   */
  afterAll((done) => {
    server.close(done);
  });

  describe('HTTP Responses', () => {
    test('should return 200 status code', async () => {
      const response = await request(server).get('/');
      expect(response.status).toBe(EXPECTED_STATUS);
    });

    test('should return Content-Type text/plain header', async () => {
      const response = await request(server).get('/');
      expect(response.headers['content-type']).toMatch(/text\/plain/);
    });

    test('should return Hello, World! with newline', async () => {
      const response = await request(server).get('/');
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should return response with correct content type', async () => {
      await request(server)
        .get('/')
        .expect('Content-Type', /text\/plain/)
        .expect(EXPECTED_STATUS);
    });
  });

  describe('HTTP Methods', () => {
    test('should handle GET request', async () => {
      const response = await request(server).get('/');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle POST request', async () => {
      const response = await request(server).post('/');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle PUT request', async () => {
      const response = await request(server).put('/');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle DELETE request', async () => {
      const response = await request(server).delete('/');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle PATCH request', async () => {
      const response = await request(server).patch('/');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle OPTIONS request', async () => {
      const response = await request(server).options('/');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should return headers but no body for HEAD request', async () => {
      const response = await request(server).head('/');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.headers['content-type']).toMatch(/text\/plain/);
      // HEAD requests should not have a body (text is undefined or empty)
      expect(response.text || '').toBe('');
    });
  });

  describe('URL Paths', () => {
    test('should handle root path /', async () => {
      const response = await request(server).get('/');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle arbitrary path /test', async () => {
      const response = await request(server).get('/test');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle nested path /deeply/nested/path', async () => {
      const response = await request(server).get('/deeply/nested/path');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle path with query parameters /path?query=value', async () => {
      const response = await request(server).get('/path?query=value');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    // Parameterized test for multiple paths
    test.each([
      '/',
      '/test',
      '/any/path',
      '/deep/nested/path/here',
      '/path?foo=bar&baz=qux'
    ])('should handle path: %s', async (path) => {
      const response = await request(server).get(path);
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });
  });

  describe('Combined Request Validation', () => {
    // Test various combinations of methods and paths
    test.each([
      ['get', '/'],
      ['post', '/api'],
      ['put', '/resource/123'],
      ['delete', '/item?id=456'],
      ['patch', '/update/data']
    ])('should handle %s request to %s', async (method, path) => {
      const response = await request(server)[method](path);
      expect(response.status).toBe(EXPECTED_STATUS);
      if (method !== 'head') {
        expect(response.text).toBe(EXPECTED_BODY);
      }
    });

    test('should handle request with custom headers', async () => {
      const response = await request(server)
        .get('/')
        .set('X-Custom-Header', 'test-value')
        .set('Accept', 'text/plain');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle request with body data', async () => {
      const response = await request(server)
        .post('/submit')
        .send({ key: 'value' })
        .set('Content-Type', 'application/json');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });
  });
});
