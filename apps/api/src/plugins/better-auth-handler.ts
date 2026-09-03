import type { FastifyInstance } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { auth } from '../auth/auth.js';

export async function betterAuthHandler(
  fastify: FastifyInstance,
  options?: { auth: typeof auth; appOrigin: string },
) {
  if (!options?.auth) throw new Error('Better Auth handler requires auth');
  fastify.route({
    method: ['GET', 'POST'],
    url: '/auth/*',
    handler: async (request, reply) => {
      if (
        request.method === 'POST' &&
        new URL(request.raw.url ?? request.url, options.appOrigin).pathname.endsWith(
          '/auth/sign-up/email',
        )
      )
        return reply.code(404).send();
      const url = new URL(request.raw.url ?? request.url, options.appOrigin);
      const headers = fromNodeHeaders(request.headers);
      const body =
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : request.body instanceof Buffer
            ? request.body
            : undefined;
      const fetchRequest = new Request(url, {
        method: request.method,
        headers,
        body: body as BodyInit | null | undefined,
      });
      try {
        const response = await options.auth.handler(fetchRequest);
        const cookies = response.headers.getSetCookie();
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
        });
        if (cookies.length > 0) reply.header('set-cookie', cookies);
        reply.code(response.status);
        return reply.send(Buffer.from(await response.arrayBuffer()));
      } catch {
        return reply.code(500).send({ error: 'Internal authentication error' });
      }
    },
  });
}
