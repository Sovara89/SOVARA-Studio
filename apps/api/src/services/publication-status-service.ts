import type { createPublicationRepository } from '@sovara-studio/db';

type Repository = ReturnType<typeof createPublicationRepository>;

export class PublicationStatusError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'PublicationStatusError';
  }
}

function safeFailureMessage(code: string | null) {
  if (!code) return null;
  if (code.includes('REAUTHORIZATION')) return 'Reconnect the publishing account and retry.';
  return 'Publication failed. Review the account and retry when ready.';
}

function response(publication: Awaited<ReturnType<Repository['listForUser']>>[number]) {
  return {
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
    revision: publication.revision,
    nextAttemptAt: publication.nextAttemptAt?.toISOString() ?? null,
    publishedAt: publication.publishedAt?.toISOString() ?? null,
    result: publication.remoteMediaId
      ? { remoteMediaId: publication.remoteMediaId, remoteUrl: publication.remoteUrl }
      : null,
    error: publication.failureCode
      ? {
          code: publication.failureCode,
          message: safeFailureMessage(publication.failureCode),
          retryable: publication.state === 'retry_wait' || publication.state === 'failed',
        }
      : null,
    updatedAt: publication.updatedAt.toISOString(),
  };
}

export function createPublicationStatusService(deps: { publications: Repository }) {
  return {
    async list(userId: string) {
      return (await deps.publications.listForUser(userId)).map(response);
    },
    async retry(userId: string, publicationId: string, revision: number) {
      const current = (await deps.publications.findByIdForUser(userId, publicationId))[0];
      if (!current) throw new PublicationStatusError('NOT_FOUND', 'Publication was not found');
      if (current.state !== 'failed' || current.revision !== revision)
        throw new PublicationStatusError('CONFLICT', 'Publication changed or cannot be retried');
      const retried = await deps.publications.retryFailedPublication(
        userId,
        publicationId,
        revision,
      );
      if (!retried[0])
        throw new PublicationStatusError('CONFLICT', 'Publication changed or cannot be retried');
      return response(retried[0]);
    },
  };
}
