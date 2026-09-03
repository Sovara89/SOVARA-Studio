import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { publicationStatusRoutes } from './publication-status.js';

describe('publication status routes', () => {
  let server: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => server?.close());

  test('uses the authenticated owner and does not expose another user status', async () => {
    const list = vi.fn().mockResolvedValue([]);
    server = Fastify();
    server.decorateRequest('studioAuth', null);
    server.decorate('requireStudioUser', async (request) => {
      request.studioAuth = { userId: 'owner-id', sessionId: 'session-id' };
    });
    await server.register(publicationStatusRoutes, {
      service: { list } as never,
      prefix: '/api',
    });

    const response = await server.inject({ method: 'GET', url: '/api/publication-status' });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith('owner-id');
  });
});
