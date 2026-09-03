import type { createPublicationRepository } from '@sovara-studio/db';

type Repository = ReturnType<typeof createPublicationRepository>;

export function createPublicationStatusService(deps: { publications: Repository }) {
  return {
    async list(userId: string) {
      return (await deps.publications.listForUser(userId)).map((publication) => ({
        id: publication.id,
        videoId: publication.videoId,
        platform: publication.platform as 'youtube' | 'vk',
        publishingAccountId: publication.publishingAccountId,
        state: publication.state as
          | 'queued'
          | 'publishing'
          | 'reconciling'
          | 'retry_wait'
          | 'manual_review'
          | 'published'
          | 'failed'
          | 'cancelled',
        attemptCount: publication.attemptCount,
        nextAttemptAt: publication.nextAttemptAt?.toISOString() ?? null,
        publishedAt: publication.publishedAt?.toISOString() ?? null,
        result: publication.remoteMediaId
          ? { remoteMediaId: publication.remoteMediaId, remoteUrl: publication.remoteUrl }
          : null,
        error: publication.failureCode
          ? {
              code: publication.failureCode,
              message: publication.failureMessage,
              retryable: publication.state === 'retry_wait',
            }
          : null,
        updatedAt: publication.updatedAt.toISOString(),
      }));
    },
  };
}
