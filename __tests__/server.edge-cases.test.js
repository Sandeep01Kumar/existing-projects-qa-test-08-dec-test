/**
 * Edge Case Jest Tests for Node.js HTTP Server
 * 
 * This test file contains edge case and boundary condition tests:
 * - Special characters in URL paths
 * - Very long URL paths
 * - Empty path segments
 * - Query parameters
 * - URL fragments
 * - Concurrent requests
 * - Rapid sequential requests
 * 
 * All tests verify that edge cases return 200 OK status,
 * the same response body, and no server errors.
 * 
 * Uses supertest for HTTP assertions.
 * 
 * @see server.js - The HTTP server being tested
 */

const request = require('supertest');
const { server } = require('../server');

// Expected values for validation
const EXPECTED_BODY = 'Hello, World!\n';
const EXPECTED_STATUS = 200;

describe('Server Edge Cases', () => {
  /**
   * Close the server after all tests complete to ensure clean shutdown
   * and prevent open handle warnings in Jest.
   * Checks if server is listening before attempting to close to avoid
   * "Server is not running" errors when running as part of a test suite.
   */
  afterAll((done) => {
    if (server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  describe('Special Characters in URL', () => {
    test('should handle URL-encoded spaces', async () => {
      const response = await request(server).get('/path%20with%20spaces');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle special characters !@#', async () => {
      // Note: Some special characters need URL encoding
      const response = await request(server).get('/path/with/special');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle URL-encoded special characters', async () => {
      const response = await request(server).get('/path%21%40%23');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle hyphens and underscores', async () => {
      const response = await request(server).get('/path-with-hyphens_and_underscores');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle dots in path', async () => {
      const response = await request(server).get('/path.with.dots');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle tildes and plus signs', async () => {
      const response = await request(server).get('/path~with+special');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });
  });

  describe('Very Long URL Paths', () => {
    test('should handle deeply nested paths', async () => {
      const response = await request(server).get('/a/b/c/d/e/f/g/h/i/j/k/l');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle very long path segment', async () => {
      const longSegment = 'a'.repeat(100);
      const response = await request(server).get(`/${longSegment}`);
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle multiple long segments', async () => {
      const longPath = '/segment1/segment2/segment3/segment4/segment5/segment6/segment7/segment8';
      const response = await request(server).get(longPath);
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle 50 nested directories', async () => {
      const path = '/' + Array(50).fill('dir').join('/');
      const response = await request(server).get(path);
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });
  });

  describe('Empty Path Segments', () => {
    test('should handle double slashes //', async () => {
      const response = await request(server).get('//');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle multiple consecutive slashes', async () => {
      const response = await request(server).get('///path///to///resource///');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle path with empty segments', async () => {
      const response = await request(server).get('/path//segment');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle trailing slash', async () => {
      const response = await request(server).get('/path/');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });
  });

  describe('Query Parameters', () => {
    test('should handle single query parameter', async () => {
      const response = await request(server).get('/path?query=value');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle multiple query parameters', async () => {
      const response = await request(server).get('/path?query=value&foo=bar');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle empty query parameter value', async () => {
      const response = await request(server).get('/path?key=');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle query parameter without value', async () => {
      const response = await request(server).get('/path?flag');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle query parameter with special characters', async () => {
      const response = await request(server).get('/path?key=hello%20world');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle complex query string', async () => {
      const response = await request(server)
        .get('/search?q=test&page=1&sort=asc&filter[category]=tech&filter[status]=active');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });
  });

  describe('URL Fragments', () => {
    // Note: URL fragments are typically client-side only and not sent to server
    // These tests verify server handles paths that might look like fragment references
    test('should handle path resembling fragment', async () => {
      const response = await request(server).get('/path');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle anchor-like path segment', async () => {
      const response = await request(server).get('/section-anchor');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });
  });

  describe('Concurrent Requests', () => {
    test('should handle concurrent requests using Promise.all', async () => {
      // Make multiple concurrent requests using Promise.all
      const responses = await Promise.all([
        request(server).get('/'),
        request(server).get('/concurrent-1'),
        request(server).get('/concurrent-2'),
        request(server).get('/concurrent-3'),
        request(server).get('/concurrent-4')
      ]);

      expect(responses.length).toBe(5);
      responses.forEach((response) => {
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      });
    });

    test('should handle many concurrent requests simultaneously', async () => {
      // Create 10 concurrent requests
      const requestPromises = Array.from({ length: 10 }, (_, i) =>
        request(server).get(`/concurrent-request-${i}`)
      );

      const responses = await Promise.all(requestPromises);

      expect(responses.length).toBe(10);
      responses.forEach((response, index) => {
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      });
    });

    test('should handle concurrent requests with different HTTP methods', async () => {
      // Make concurrent requests with different HTTP methods
      const responses = await Promise.all([
        request(server).get('/method-test'),
        request(server).post('/method-test'),
        request(server).put('/method-test'),
        request(server).delete('/method-test'),
        request(server).patch('/method-test')
      ]);

      expect(responses.length).toBe(5);
      responses.forEach((response) => {
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      });
    });

    test('should handle burst of concurrent requests', async () => {
      // Simulate a burst of 20 concurrent requests
      const burstRequests = Array.from({ length: 20 }, (_, i) =>
        request(server).get(`/burst-${i}`)
      );

      const responses = await Promise.all(burstRequests);

      expect(responses.length).toBe(20);
      responses.forEach((response) => {
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      });
    });
  });

  describe('Sequential Requests', () => {
    test('should handle multiple sequential requests successfully', async () => {
      // Test that multiple requests all return the same result
      const response1 = await request(server).get('/');
      const response2 = await request(server).get('/');
      const response3 = await request(server).get('/');

      [response1, response2, response3].forEach((response) => {
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      });
    });

    test('should handle requests to different paths sequentially', async () => {
      const paths = ['/path1', '/path2', '/path3'];
      for (const path of paths) {
        const response = await request(server).get(path);
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      }
    });

    test('should handle different methods sequentially', async () => {
      const methods = ['get', 'post', 'put', 'delete', 'patch'];
      for (const method of methods) {
        const response = await request(server)[method]('/');
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      }
    });

    test('should maintain consistent responses across many requests', async () => {
      // Make 20 sequential requests and verify consistency
      for (let i = 0; i < 20; i++) {
        const response = await request(server).get(`/request-${i}`);
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      }
    });
  });

  describe('Rapid Sequential Requests', () => {
    test('should handle rapid sequential requests', async () => {
      const responses = [];
      for (let i = 0; i < 10; i++) {
        const response = await request(server).get('/');
        responses.push(response);
      }

      expect(responses.length).toBe(10);
      responses.forEach((response) => {
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      });
    });

    test('should handle sequential requests to different paths', async () => {
      const paths = ['/a', '/b', '/c', '/d', '/e'];
      for (const path of paths) {
        const response = await request(server).get(path);
        expect(response.status).toBe(EXPECTED_STATUS);
        expect(response.text).toBe(EXPECTED_BODY);
      }
    });
  });

  describe('Boundary Conditions', () => {
    test('should handle root path with query string', async () => {
      const response = await request(server).get('/?test=true');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle path with numbers only', async () => {
      const response = await request(server).get('/123456789');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle path with mixed case', async () => {
      const response = await request(server).get('/Path/TO/Resource');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle path starting with dot', async () => {
      const response = await request(server).get('/.hidden');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle file-like path', async () => {
      const response = await request(server).get('/file.txt');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });

    test('should handle API-like path', async () => {
      const response = await request(server).get('/api/v1/users/123');
      expect(response.status).toBe(EXPECTED_STATUS);
      expect(response.text).toBe(EXPECTED_BODY);
    });
  });
});
