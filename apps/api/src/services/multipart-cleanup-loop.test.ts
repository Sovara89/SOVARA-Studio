import { describe, expect, test, vi } from 'vitest';
import { createMultipartCleanupLoop } from './multipart-cleanup-loop.js';

const expired = {
  id: 'upload-1',
  userId: 'owner-1',
  videoId: 'video-1',
  state: 'active',
  revision: 3,
};

describe('multipart cleanup loop', () => {
  test('claims an expired upload before invoking production cleanup', async () => {
    const cleanupExpired = vi.fn().mockResolvedValue(undefined);
    const recoverPendingInitiations = vi.fn().mockResolvedValue([]);
    const claimCleanupCandidate = vi
      .fn()
      .mockResolvedValue([{ ...expired, state: 'abort_pending', revision: 4 }]);
    const loop = createMultipartCleanupLoop({
      uploads: {
        listCleanupCandidates: vi.fn().mockResolvedValue([{ upload: expired }]),
        claimCleanupCandidate,
      } as never,
      service: {
        recoverPendingInitiations,
        cleanupExpired,
      } as never,
      intervalMs: 60_000,
      batchSize: 10,
      claimTimeoutMs: 120_000,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(loop.runOnce()).resolves.toEqual({ cleaned: 1, failed: 0 });
    expect(claimCleanupCandidate).toHaveBeenCalledWith(
      expired.userId,
      expired.id,
      'active',
      3,
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2025-12-31T23:58:00.000Z'),
    );
    expect(recoverPendingInitiations).toHaveBeenCalledWith(
      10,
      new Date('2025-12-31T23:58:00.000Z'),
    );
    expect(cleanupExpired).toHaveBeenCalledWith(expired.userId, expired.videoId, expired.id);
  });

  test('does not overlap passes and never logs provider error contents', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listCleanupCandidates = vi.fn(async () => {
      await blocked;
      throw new Error('access_token=secret');
    });
    const loop = createMultipartCleanupLoop({
      uploads: { listCleanupCandidates } as never,
      service: { recoverPendingInitiations: vi.fn().mockResolvedValue([]) } as never,
      intervalMs: 60_000,
      batchSize: 10,
      claimTimeoutMs: 120_000,
    });
    const first = loop.runOnce();
    const second = loop.runOnce();
    expect(first).toBe(second);
    release();
    await expect(first).rejects.toThrow('access_token=secret');
    expect(listCleanupCandidates).toHaveBeenCalledOnce();
  });
});
