import { randomUUID } from 'node:crypto';
import type { createPublicationIntentRepository } from '@sovara-studio/db';
import type { createPublicationRepository } from '@sovara-studio/db';
import type { PrivatePreviewStorage } from '@sovara-studio/infra';
import type {
  CreatePublicationIntentRequest,
  UpdatePublicationIntentRequest,
} from '@sovara-studio/contracts';

type Repository = ReturnType<typeof createPublicationIntentRepository>;
type PublicationRepository = ReturnType<typeof createPublicationRepository>;
export class PublicationIntentError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'VIDEO_NOT_READY'
      | 'ACCOUNT_NOT_AVAILABLE'
      | 'PREVIEW_INVALID'
      | 'STORAGE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}
function response(row: Awaited<ReturnType<Repository['findForUser']>>[number]) {
  return {
    id: row.id,
    videoId: row.videoId,
    platform: row.platform as 'youtube' | 'vk',
    publishingAccountId: row.publishingAccountId,
    mode: row.mode as 'DRAFT' | 'PUBLISH_NOW' | 'SCHEDULED',
    title: row.title,
    description: row.description,
    link: row.link,
    createCommunityPost: row.createCommunityPost,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    preview:
      row.previewObjectKey && row.previewContentType && row.previewSizeBytes && row.previewState
        ? {
            contentType: row.previewContentType,
            sizeBytes: row.previewSizeBytes,
            state: row.previewState as 'pending' | 'ready',
          }
        : null,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function createPublicationIntentService(deps: {
  intents: Repository;
  previewStorage: PrivatePreviewStorage;
  publications?: PublicationRepository;
  previewUrlTtlSeconds?: number;
  vkCommunityConfigured?: boolean;
  onPreviewCleanupFailure?: (event: { intentId: string }) => void;
}) {
  const mapInput = (input: CreatePublicationIntentRequest) => ({
    ...input,
    scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
  });
  const mapError = (error: unknown) => {
    if (error instanceof PublicationIntentError) throw error;
    if (error instanceof Error && error.message === 'VIDEO_NOT_READY')
      throw new PublicationIntentError('VIDEO_NOT_READY', 'Only a ready video can be composed');
    if (error instanceof Error && error.message === 'ACCOUNT_NOT_AVAILABLE')
      throw new PublicationIntentError(
        'ACCOUNT_NOT_AVAILABLE',
        'The selected publishing account is unavailable',
      );
    throw new PublicationIntentError('STORAGE_UNAVAILABLE', 'The request could not be completed');
  };
  return {
    async create(userId: string, input: CreatePublicationIntentRequest) {
      if (input.platform === 'vk' && input.createCommunityPost && !deps.vkCommunityConfigured)
        throw new PublicationIntentError(
          'ACCOUNT_NOT_AVAILABLE',
          'VK community posting is not configured',
        );
      try {
        const rows = await deps.intents.create(userId, mapInput(input));
        if (!rows[0])
          throw new PublicationIntentError(
            'CONFLICT',
            'A platform intent already exists for this video',
          );
        return response(rows[0]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new PublicationIntentError(
            'CONFLICT',
            'A platform intent already exists for this video',
          );
        return mapError(error);
      }
    },
    async list(userId: string) {
      return (await deps.intents.listForUser(userId)).map(response);
    },
    async publish(userId: string, id: string, revision: number) {
      const current = (await deps.intents.findForUser(userId, id))[0];
      if (!current) throw new PublicationIntentError('NOT_FOUND', 'Publication intent was not found');
      if (current.revision !== revision)
        throw new PublicationIntentError('CONFLICT', 'This intent changed; refresh and retry');
      if (!deps.publications)
        throw new PublicationIntentError('STORAGE_UNAVAILABLE', 'Publication is temporarily unavailable');

      const existing = await deps.publications.findForUserByVideoAndAccount(
        userId,
        current.videoId,
        current.publishingAccountId,
      );
      if (existing[0]) return { publicationId: existing[0].id };
      try {
        const created = await deps.publications.createOwnedPublication(userId, {
          videoId: current.videoId,
          publishingAccountId: current.publishingAccountId,
          platform: current.platform as 'youtube' | 'vk',
          title: current.title,
          description: current.description,
          metadata: { link: current.link, createCommunityPost: current.createCommunityPost },
        });
        if (!created[0]) throw new Error('Publication was not created');
        return { publicationId: created[0].id };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          const duplicate = await deps.publications.findForUserByVideoAndAccount(
            userId,
            current.videoId,
            current.publishingAccountId,
          );
          if (duplicate[0]) return { publicationId: duplicate[0].id };
        }
        return mapError(error);
      }
    },
    async update(userId: string, id: string, input: UpdatePublicationIntentRequest) {
      const current = (await deps.intents.findForUser(userId, id))[0];
      if (!current)
        throw new PublicationIntentError('NOT_FOUND', 'Publication intent was not found');
      if (current.platform === 'vk' && input.createCommunityPost && !deps.vkCommunityConfigured)
        throw new PublicationIntentError(
          'ACCOUNT_NOT_AVAILABLE',
          'VK community posting is not configured',
        );
      const { revision, scheduledAt, link, ...values } = input;
      const rows = await deps.intents.update(userId, id, revision, {
        ...values,
        link: link === undefined ? current.link : link,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      });
      if (!rows[0])
        throw new PublicationIntentError('CONFLICT', 'This intent changed; refresh and retry');
      return response(rows[0]);
    },
    async preparePreview(
      userId: string,
      id: string,
      input: { contentType: string; sizeBytes: number; revision: number },
    ) {
      const current = (await deps.intents.findForUser(userId, id))[0];
      if (!current)
        throw new PublicationIntentError('NOT_FOUND', 'Publication intent was not found');
      if (current.revision !== input.revision)
        throw new PublicationIntentError('CONFLICT', 'This intent changed; refresh and retry');
      const objectKey = `previews/${userId}/${id}/staging/${randomUUID()}`;
      const preserveReadyPreview =
        current.previewState === 'ready' && Boolean(current.previewObjectKey);
      const supersededCandidateKey = preserveReadyPreview
        ? current.pendingPreviewObjectKey
        : current.previewObjectKey;
      let url: string;
      try {
        url = await deps.previewStorage.presignPut({
          objectKey,
          contentType: input.contentType,
          expiresInSeconds: deps.previewUrlTtlSeconds ?? 300,
        });
      } catch {
        throw new PublicationIntentError(
          'STORAGE_UNAVAILABLE',
          'Preview upload is temporarily unavailable',
        );
      }
      const rows = await deps.intents.beginPreview(
        userId,
        id,
        input.revision,
        { objectKey, contentType: input.contentType, sizeBytes: input.sizeBytes },
        preserveReadyPreview,
      );
      if (!rows[0]) {
        void deps.previewStorage.deleteObject(objectKey).catch(() => undefined);
        throw new PublicationIntentError('CONFLICT', 'This intent changed; refresh and retry');
      }
      if (supersededCandidateKey)
        void deps.previewStorage.deleteObject(supersededCandidateKey).catch(() => undefined);
      return { uploadUrl: url, revision: rows[0].revision };
    },
    async completePreview(userId: string, id: string, revision: number) {
      const current = (await deps.intents.findForUser(userId, id))[0];
      if (!current)
        throw new PublicationIntentError('NOT_FOUND', 'Publication intent was not found');
      const replacingReadyPreview =
        current.previewState === 'ready' && Boolean(current.pendingPreviewObjectKey);
      const candidateObjectKey = replacingReadyPreview
        ? current.pendingPreviewObjectKey!
        : current.previewObjectKey;
      const candidateContentType = replacingReadyPreview
        ? current.pendingPreviewContentType
        : current.previewContentType;
      const candidateSizeBytes = replacingReadyPreview
        ? current.pendingPreviewSizeBytes
        : current.previewSizeBytes;
      if (
        current.revision !== revision ||
        (!replacingReadyPreview && current.previewState !== 'pending') ||
        !candidateObjectKey ||
        !candidateContentType ||
        !candidateSizeBytes
      )
        throw new PublicationIntentError('CONFLICT', 'Preview upload changed; refresh and retry');
      let object;
      try {
        object = await deps.previewStorage.headObject(candidateObjectKey);
      } catch {
        throw new PublicationIntentError(
          'STORAGE_UNAVAILABLE',
          'Preview verification is temporarily unavailable',
        );
      }
      if (
        object === 'absent' ||
        object.contentLength !== candidateSizeBytes ||
        object.contentType?.split(';', 1)[0]?.toLowerCase() !== candidateContentType
      )
        throw new PublicationIntentError(
          'PREVIEW_INVALID',
          'Preview did not match the requested file',
        );
      if (!object.etag)
        throw new PublicationIntentError(
          'STORAGE_UNAVAILABLE',
          'Preview verification could not establish an immutable object version',
        );
      const readyObjectKey = `previews/${userId}/${id}/ready/${randomUUID()}`;
      try {
        await deps.previewStorage.finalizeStagedObject({
          stagingObjectKey: candidateObjectKey,
          readyObjectKey,
          etag: object.etag,
        });
      } catch {
        throw new PublicationIntentError(
          'PREVIEW_INVALID',
          'Preview changed during verification; upload it again',
        );
      }
      const rows = await deps.intents.completePreview(userId, id, revision, replacingReadyPreview, {
        objectKey: readyObjectKey,
        contentType: candidateContentType,
        sizeBytes: candidateSizeBytes,
      });
      if (!rows[0]) {
        void deps.previewStorage.deleteObject(readyObjectKey).catch(() => undefined);
        throw new PublicationIntentError('CONFLICT', 'Preview upload changed; refresh and retry');
      }
      void deps.previewStorage.deleteObject(candidateObjectKey).catch(() => undefined);
      if (replacingReadyPreview && current.previewObjectKey)
        void deps.previewStorage.deleteObject(current.previewObjectKey).catch(() => undefined);
      return response(rows[0]);
    },
    async removePreview(userId: string, id: string, revision: number) {
      const current = (await deps.intents.findForUser(userId, id))[0];
      if (!current)
        throw new PublicationIntentError('NOT_FOUND', 'Publication intent was not found');
      const rows = await deps.intents.removePreview(userId, id, revision);
      if (!rows[0])
        throw new PublicationIntentError('CONFLICT', 'This intent changed; refresh and retry');

      // The CAS state change is authoritative. Never remove an object until the intent no longer
      // references it; a stale/foreign request must leave every existing preview intact.
      const objectKeys = [current.previewObjectKey, current.pendingPreviewObjectKey].filter(
        (key): key is string => Boolean(key),
      );
      // The database CAS is authoritative. Cleanup errors are deliberately not returned to the
      // caller, and the error itself is never logged because storage providers may include secrets.
      void Promise.allSettled(
        objectKeys.map((objectKey) => deps.previewStorage.deleteObject(objectKey)),
      ).then((results) => {
        if (results.some((result) => result.status === 'rejected')) {
          try {
            deps.onPreviewCleanupFailure?.({ intentId: id });
          } catch {
            // Observability must not affect the completed unlink.
          }
        }
      });
      return response(rows[0]);
    },
  };
}
