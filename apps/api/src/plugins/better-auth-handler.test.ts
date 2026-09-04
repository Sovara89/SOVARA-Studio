import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { betterAuthHandler } from './better-auth-handler.js';

describe('Better Auth Fastify bridge', () => {
  test('preserves raw request data and multiple response cookies', async () => {
    const seen: { method?: string; url?: string; body?: string } = {};
    const fakeAuth = {
      handler: async (request: Request) => {
        seen.method = request.method;
        seen.url = request.url;
        seen.body = await request.text();
        const response = new Response('response', { status: 201, headers: { 'x-test': 'ok' } });
        response.headers.append('set-cookie', 'first=1; Path=/');
        response.headers.append('set-cookie', 'second=2; Path=/');
        return response;
      },
    };
    const server = Fastify({ logger: false });
    server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    await server.register(betterAuthHandler, {
      auth: fakeAuth as never,
      appOrigin: 'http://localhost:5173',
    });
    const response = await server.inject({
      method: 'POST',
      url: '/auth/example?x=1',
      headers: { 'content-type': 'application/json' },
      payload: '{"raw":true}',
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['x-test']).toBe('ok');
    expect(response.headers['set-cookie']).toEqual(['first=1; Path=/', 'second=2; Path=/']);
    expect(seen).toEqual({
      method: 'POST',
      url: 'http://localhost:5173/auth/example?x=1',
      body: '{"raw":true}',
    });
    await server.close();
  });

  test('blocks public email signup before Better Auth', async () => {
    let called = false;
    const server = Fastify({ logger: false });
    await server.register(betterAuthHandler, {
      auth: {
        handler: async () => {
          called = true;
          return new Response();
        },
      } as never,
      appOrigin: 'http://localhost:5173',
    });
    const response = await server.inject({ method: 'POST', url: '/auth/sign-up/email' });
    expect(response.statusCode).toBe(404);
    expect(called).toBe(false);
    await server.close();
  });

});
