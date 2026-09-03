import { afterEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerApp } from '../app.js';

describe('Health routes', () => {
  let fastify: FastifyInstance;

  test('should return ok on /health', async () => {
    fastify = Fastify({ logger: false });
    await fastify.register(registerApp, { prefix: '/api' });
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/health',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  test('should return unavailable when no database is configured', async () => {
    fastify = Fastify({ logger: false });
    await fastify.register(registerApp, { prefix: '/api' });
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/ready',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Database unavailable' });
  });

  test('should return ready when the database query succeeds', async () => {
    fastify = Fastify({ logger: false });
    await fastify.register(registerApp, {
      prefix: '/api',
      database: { pool: { query: async () => ({}) } } as never,
    });
    const response = await fastify.inject({ method: 'GET', url: '/api/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  test('should return unavailable when the database query rejects', async () => {
    fastify = Fastify({ logger: false });
    await fastify.register(registerApp, {
      prefix: '/api',
      database: {
        pool: {
          query: async () => {
            throw new Error('down');
          },
        },
      } as never,
    });
    const response = await fastify.inject({ method: 'GET', url: '/api/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Database unavailable' });
  });

  test('should return unavailable when the database query times out', async () => {
    fastify = Fastify({ logger: false });
    await fastify.register(registerApp, {
      prefix: '/api',
      database: { pool: { query: () => new Promise(() => undefined) } } as never,
    });
    const response = await fastify.inject({ method: 'GET', url: '/api/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Database unavailable' });
  }, 3000);

  afterEach(async () => {
    await fastify.close();
  });
});
