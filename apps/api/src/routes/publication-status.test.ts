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
      appOrigin: 'https://studio.example',
      prefix: '/api',
    });

    const response = await server.inject({ method: 'GET', url: '/api/publication-status' });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith('owner-id');
  });

  test('retries with authenticated ownership, origin, and revision', async () => {
    const retry = vi.fn().mockResolvedValue({ id: 'publication-id', state: 'queued' });
    server = Fastify();
    server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    server.decorateRequest('studioAuth', null);
    server.decorate('requireStudioUser', async (request) => {
      request.studioAuth = { userId: 'owner-id', sessionId: 'session-id' };
    });
    await server.register(publicationStatusRoutes, {
      service: { list: vi.fn(), retry } as never,
      appOrigin: 'https://studio.example',
      prefix: '/api',
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/publication-status/4c4f8e30-e24e-4cde-9534-a43f4b3f98e8/retry',
      headers: { origin: 'https://studio.example', 'content-type': 'application/json' },
      payload: { revision: 4 },
    });
    expect(response.statusCode).toBe(200);
    expect(retry).toHaveBeenCalledWith('owner-id', '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8', 4);
  });

  test('rejects retry from a foreign origin before touching the service', async () => {
    const retry = vi.fn();
    server = Fastify();
    server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    server.decorateRequest('studioAuth', null);
    server.decorate('requireStudioUser', async (request) => {
      request.studioAuth = { userId: 'owner-id', sessionId: 'session-id' };
    });
    await server.register(publicationStatusRoutes, {
      service: { list: vi.fn(), retry } as never,
      appOrigin: 'https://studio.example',
      prefix: '/api',
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/publication-status/4c4f8e30-e24e-4cde-9534-a43f4b3f98e8/retry',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: { revision: 4 },
    });
    expect(response.statusCode).toBe(409);
    expect(retry).not.toHaveBeenCalled();
  });
});
