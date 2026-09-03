import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { createDatabase } from '@sovara-studio/db';
import { healthRoutes } from './routes/health.js';
import { betterAuthHandler } from './plugins/better-auth-handler.js';
import { authentication } from './plugins/authentication.js';
import type { auth } from './auth/auth.js';
import type { createMultipartUploadService } from './services/multipart-upload-service.js';
import { videoUploadRoutes } from './routes/video-uploads.js';
import { publishingAccountRoutes } from './routes/publishing-accounts.js';
import type { createOAuthService } from './services/oauth-service.js';
import { publicationIntentRoutes } from './routes/publication-intents.js';
import type { createPublicationIntentService } from './services/publication-intent-service.js';
import { publicationStatusRoutes } from './routes/publication-status.js';
import type { createPublicationStatusService } from './services/publication-status-service.js';

export async function registerApp(
  fastify: FastifyInstance,
  options: FastifyPluginOptions & {
    auth?: typeof auth;
    appOrigin?: string;
    database?: ReturnType<typeof createDatabase>;
    uploadService?: ReturnType<typeof createMultipartUploadService>;
    oauthService?: ReturnType<typeof createOAuthService>;
    publicationIntentService?: ReturnType<typeof createPublicationIntentService>;
    publicationStatusService?: ReturnType<typeof createPublicationStatusService>;
  } = {},
) {
  await fastify.register(healthRoutes, { database: options.database });
  if (options?.auth) {
    const authInstance = options.auth;
    await authentication(fastify, { auth: authInstance });
    await betterAuthHandler(fastify, {
      auth: authInstance,
      appOrigin: options.appOrigin ?? 'http://localhost:5173',
    });
    if (options.uploadService) {
      await fastify.register(videoUploadRoutes, {
        uploadService: options.uploadService,
        appOrigin: options.appOrigin ?? 'http://localhost:5173',
      });
    }
    if (options.oauthService) {
      await fastify.register(publishingAccountRoutes, {
        oauthService: options.oauthService,
        appOrigin: options.appOrigin ?? 'http://localhost:5173',
      });
    }
    if (options.publicationIntentService)
      await fastify.register(publicationIntentRoutes, {
        service: options.publicationIntentService,
        appOrigin: options.appOrigin ?? 'http://localhost:5173',
      });
    if (options.publicationStatusService)
      await fastify.register(publicationStatusRoutes, {
        service: options.publicationStatusService,
        appOrigin: options.appOrigin ?? 'http://localhost:5173',
      });
    fastify.get('/me', { preHandler: fastify.requireStudioUser }, async (request) => ({
      userId: request.studioAuth?.userId,
    }));
  }
}
