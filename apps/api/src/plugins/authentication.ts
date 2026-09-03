import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { auth } from '../auth/auth.js';

export async function authentication(fastify: FastifyInstance, options?: { auth: typeof auth }) {
  if (!options?.auth) throw new Error('Authentication plugin requires auth');
  fastify.decorateRequest('studioAuth', null);
  fastify.decorate('requireStudioUser', async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await options.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    request.studioAuth = { userId: session.user.id, sessionId: session.session.id };
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireStudioUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
