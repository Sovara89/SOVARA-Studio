import Fastify, { type FastifyRequest } from 'fastify';
import { registerApp } from './app.js';
import {
  API_PORT,
  APP_ORIGIN,
  credentialConfiguration,
  loadStorageConfiguration,
  oauthConfiguration,
  environment,
} from './env.js';
import { auth, database } from './auth/auth.js';
import {
  createMultipartUploadRepository,
  createVideoRepository,
  createPublicationIntentRepository,
  createPublicationRepository,
} from '@sovara-studio/db';
import { createMultipartUploadService } from './services/multipart-upload-service.js';
import {
  createS3Client,
  createS3MultipartStorage,
  createS3PrivatePreviewStorage,
} from '@sovara-studio/infra';
import { createConfiguredOAuthProviders, createOAuthService } from './services/oauth-service.js';
import { createPublicationIntentService } from './services/publication-intent-service.js';
import { createPublicationStatusService } from './services/publication-status-service.js';

const storageConfiguration = loadStorageConfiguration();
const storageClient = createS3Client({
  ...storageConfiguration.s3,
  maxAttempts: 1,
});
const presignClient = storageConfiguration.s3.presignEndpoint
  ? createS3Client({
      ...storageConfiguration.s3,
      endpoint: storageConfiguration.s3.presignEndpoint,
      maxAttempts: 1,
    })
  : storageClient;
const uploadService = createMultipartUploadService({
  videos: createVideoRepository(database.db),
  uploads: createMultipartUploadRepository(database.db),
  storage: createS3MultipartStorage(
    storageClient,
    { bucket: storageConfiguration.s3.bucket },
    presignClient,
    storageConfiguration.s3ControlRequestTimeoutMs,
  ),
  configuration: storageConfiguration,
});
const oauthService = createOAuthService({
  database,
  credentialConfiguration,
  providers: createConfiguredOAuthProviders(oauthConfiguration),
  redirectUris: {
    youtube:
      oauthConfiguration.youtube?.redirectUri ??
      `${APP_ORIGIN}/api/publishing-accounts/youtube/oauth/callback`,
    vk:
      oauthConfiguration.vk?.redirectUri ??
      `${APP_ORIGIN}/api/publishing-accounts/vk/oauth/callback`,
  },
});
const server = Fastify({
  logger: {
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: request.url.includes('/oauth/callback')
          ? new URL(request.url, 'http://localhost').pathname
          : request.url,
        hostname: request.hostname,
        remoteAddress: request.ip,
        remotePort: request.socket.remotePort,
      }),
    },
  },
  bodyLimit: 64 * 1024,
});
const publicationIntentService = createPublicationIntentService({
  intents: createPublicationIntentRepository(database.db),
  previewStorage: createS3PrivatePreviewStorage(
    storageClient,
    storageConfiguration.s3.bucket,
    presignClient,
  ),
  vkCommunityConfigured: Boolean(environment.VK_GROUP_ID),
  onPreviewCleanupFailure: ({ intentId }) =>
    server.log.warn({ event: 'preview_cleanup_failed', intentId }, 'Preview cleanup failed'),
});
const publicationStatusService = createPublicationStatusService({
  publications: createPublicationRepository(database.db),
});

server.addContentTypeParser(
  ['application/json', 'application/x-www-form-urlencoded'],
  { parseAs: 'buffer' },
  (_request, body, done) => done(null, body),
);
server.register(registerApp, {
  prefix: '/api',
  auth,
  appOrigin: APP_ORIGIN,
  database,
  uploadService,
  oauthService,
  publicationIntentService,
  publicationStatusService,
});

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.log.info(`Received ${signal}; shutting down`);
  await server.close();
  await database.pool.end();
  storageClient.destroy();
  if (presignClient !== storageClient) presignClient.destroy();
};

const handleSignal = (signal: string) => {
  void shutdown(signal).catch((err) => server.log.error(err));
};

process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('SIGINT', () => handleSignal('SIGINT'));

const start = async () => {
  try {
    await server.listen({
      host: '0.0.0.0',
      port: API_PORT,
    });
    server.log.info(`Server listening on ${server.server.address()}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
