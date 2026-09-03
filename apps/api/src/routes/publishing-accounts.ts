import type { FastifyInstance, FastifyReply } from 'fastify';
import { OAuthProviderError } from '@sovara-studio/platforms';
import { OAuthServiceError, type createOAuthService } from '../services/oauth-service.js';

type OAuthService = ReturnType<typeof createOAuthService>;
type Platform = 'youtube' | 'vk';

function platform(value: unknown): Platform {
  if (value === 'youtube' || value === 'vk') return value;
  throw new OAuthServiceError('not_found');
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function queryRecord(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function callbackValues(query: unknown) {
  const values = queryRecord(query);
  let payload: Record<string, unknown> = {};
  if (typeof values.payload === 'string') {
    try {
      const parsed = JSON.parse(values.payload) as unknown;
      payload = queryRecord(parsed);
    } catch {
      throw new OAuthServiceError('invalid_state');
    }
  }
  return {
    code: stringValue(values.code) ?? stringValue(payload.code),
    state: stringValue(values.state) ?? stringValue(payload.state),
    providerDeviceId: stringValue(values.device_id) ?? stringValue(payload.device_id),
    error: stringValue(values.error) ?? stringValue(payload.error),
  };
}

function requireOrigin(origin: string | undefined, appOrigin: string) {
  if (origin !== appOrigin) throw new OAuthServiceError('invalid_state');
}

function sendOAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof OAuthServiceError) {
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'not_configured'
          ? 503
          : error.code === 'conflict'
            ? 409
            : error.code === 'reauthorization_required'
              ? 401
              : error.code === 'refresh_in_progress'
                ? 503
                : 400;
    return reply.code(status).send({ error: error.code });
  }
  if (error instanceof OAuthProviderError)
    return reply.code(502).send({ error: 'provider_unavailable' });
  return reply.code(500).send({ error: 'Internal OAuth error' });
}

export async function publishingAccountRoutes(
  fastify: FastifyInstance,
  options: { oauthService: OAuthService; appOrigin: string },
) {
  const { oauthService } = options;

  fastify.get(
    '/publishing-accounts',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        return reply.code(200).send(await oauthService.list(request.studioAuth!.userId));
      } catch (error) {
        return sendOAuthError(reply, error);
      }
    },
  );

  fastify.get(
    '/publishing-accounts/:platform/oauth/start',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        const params = queryRecord(request.params);
        const query = queryRecord(request.query);
        return reply
          .code(200)
          .send(
            await oauthService.start(
              request.studioAuth!.userId,
              request.studioAuth!.sessionId,
              platform(params.platform),
              stringValue(query.accountId),
            ),
          );
      } catch (error) {
        return sendOAuthError(reply, error);
      }
    },
  );

  fastify.get(
    '/publishing-accounts/:platform/oauth/callback',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        const params = queryRecord(request.params);
        const values = callbackValues(request.query);
        if (values.error || !values.code || !values.state)
          throw new OAuthServiceError('invalid_state');
        return reply.code(200).send(
          await oauthService.complete({
            userId: request.studioAuth!.userId,
            sessionId: request.studioAuth!.sessionId,
            platform: platform(params.platform),
            code: values.code,
            state: values.state,
            providerDeviceId: values.providerDeviceId,
          }),
        );
      } catch (error) {
        return sendOAuthError(reply, error);
      }
    },
  );

  fastify.post(
    '/publishing-accounts/:platform/oauth/reconnect',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        requireOrigin(request.headers.origin, options.appOrigin);
        const params = queryRecord(request.params);
        const query = queryRecord(request.query);
        const accountId = stringValue(query.accountId);
        if (!accountId) throw new OAuthServiceError('not_found');
        return reply
          .code(200)
          .send(
            await oauthService.start(
              request.studioAuth!.userId,
              request.studioAuth!.sessionId,
              platform(params.platform),
              accountId,
            ),
          );
      } catch (error) {
        return sendOAuthError(reply, error);
      }
    },
  );

  fastify.post(
    '/publishing-accounts/:accountId/disconnect',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        requireOrigin(request.headers.origin, options.appOrigin);
        const params = queryRecord(request.params);
        const accountId = stringValue(params.accountId);
        if (!accountId) throw new OAuthServiceError('not_found');
        return reply
          .code(200)
          .send(await oauthService.disconnect(request.studioAuth!.userId, accountId));
      } catch (error) {
        return sendOAuthError(reply, error);
      }
    },
  );
}
