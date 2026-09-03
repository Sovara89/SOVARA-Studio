import { describe, expect, test, vi } from 'vitest';
import {
  createPublicationStatusService,
  PublicationStatusError,
} from './publication-status-service.js';

const failed = {
  id: 'publication-1',
  videoId: 'video-1',
  platform: 'youtube',
  publishingAccountId: 'account-1',
  state: 'failed',
  attemptCount: 5,
  revision: 9,
  nextAttemptAt: null,
  publishedAt: null,
  remoteMediaId: null,
  remoteUrl: null,
  failureCode: 'PROVIDER_FAILED',
  failureMessage: 'access_token=must-not-reach-user',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('publication status service', () => {
  test('maps persisted provider details to a controlled user-safe message', async () => {
    const service = createPublicationStatusService({
      publications: { listForUser: vi.fn().mockResolvedValue([failed]) } as never,
    });
    const result = await service.list('owner-1');
    expect(result[0]?.error).toEqual({
      code: 'PROVIDER_FAILED',
      message: 'Publication failed. Review the account and retry when ready.',
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-reach-user');
  });

  test('uses owner-scoped CAS for explicit FAILED retry', async () => {
    const retryFailedPublication = vi
      .fn()
      .mockResolvedValue([{ ...failed, state: 'queued', revision: 10, failureCode: null }]);
    const service = createPublicationStatusService({
      publications: {
        findByIdForUser: vi.fn().mockResolvedValue([failed]),
        retryFailedPublication,
      } as never,
    });
    await expect(service.retry('owner-1', failed.id, 9)).resolves.toMatchObject({
      state: 'queued',
      revision: 10,
    });
    expect(retryFailedPublication).toHaveBeenCalledWith('owner-1', failed.id, 9);
  });

  test('does not disclose whether another owner has the requested publication', async () => {
    const service = createPublicationStatusService({
      publications: { findByIdForUser: vi.fn().mockResolvedValue([]) } as never,
    });
    await expect(service.retry('owner-2', failed.id, 9)).rejects.toEqual(
      new PublicationStatusError('NOT_FOUND', 'Publication was not found'),
    );
  });
});
