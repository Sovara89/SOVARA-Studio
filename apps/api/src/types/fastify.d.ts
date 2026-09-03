import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    studioAuth: { userId: string; sessionId: string } | null;
  }
}

export type StudioRequest = FastifyRequest;
