import { describe, expect, test, vi } from 'vitest';
import { createPublicationReconciler } from './publication-reconciler.js';

const publication = {
  id: '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
  userId: '8f6a7c3b-8e7b-4f54-9e4a-1b2c3d4e5f60',
  revision: 3,
  state: 'queued' as const,
  platform: 'youtube' as const,
};

function dependencies(
  executors: ReadonlyMap<string, { executeAfterRequestSent: () => Promise<void> }>,
) {
  return {
    publications: {
      listExpiredPublicationLeases: vi.fn().mockResolvedValue([]),
      listQueueCandidates: vi.fn().mockResolvedValue([publication]),
    },
    queue: { ensurePublicationJob: vi.fn().mockResolvedValue({ action: 'created' }) },
    executors,
    intervalMs: 10_000,
    batchSize: 10,
    leaseDurationMs: 1_000,
  } as never;
}

describe('publication reconciler', () => {
  test('does not enqueue unsupported platforms', async () => {
    const input = dependencies(new Map());
    const result = await createPublicationReconciler(input).reconcileOnce();

    expect(result).toEqual({ queued: 0, recovered: 0 });
    expect(input.queue.ensurePublicationJob).not.toHaveBeenCalled();
  });

  test('enqueues only the minimal current database revision', async () => {
    const input = dependencies(new Map([['youtube', { executeAfterRequestSent: vi.fn() }]]));
    const result = await createPublicationReconciler(input).reconcileOnce();

    expect(result).toEqual({ queued: 1, recovered: 0 });
    expect(input.queue.ensurePublicationJob).toHaveBeenCalledWith({
      publicationId: publication.id,
      expectedRevision: publication.revision,
    });
  });

  test('does not enqueue candidates when shutdown wins the database await', async () => {
    const shutdown = new AbortController();
    let resolveCandidates!: (rows: (typeof publication)[]) => void;
    const input = dependencies(
      new Map([['youtube', { executeAfterRequestSent: vi.fn() }]]),
    ) as ReturnType<typeof dependencies> & { shutdownSignal: AbortSignal };
    input.shutdownSignal = shutdown.signal;
    input.publications.listQueueCandidates = vi.fn(
      () =>
        new Promise<(typeof publication)[]>((resolve) => {
          resolveCandidates = resolve;
        }),
    );
    const reconciler = createPublicationReconciler(input);
    const running = reconciler.reconcileOnce();

    await vi.waitFor(() => expect(input.publications.listQueueCandidates).toHaveBeenCalledOnce());
    shutdown.abort(new Error('shutdown'));
    resolveCandidates([publication]);

    await expect(running).resolves.toEqual({ queued: 0, recovered: 0 });
    expect(input.queue.ensurePublicationJob).not.toHaveBeenCalled();
    await expect(reconciler.reconcileOnce()).resolves.toEqual({ queued: 0, recovered: 0 });
  });

  test('close is a monotonic gate for an in-flight reconciliation pass', async () => {
    let resolveCandidates!: (rows: (typeof publication)[]) => void;
    const input = dependencies(new Map([['youtube', { executeAfterRequestSent: vi.fn() }]]));
    input.publications.listQueueCandidates = vi.fn(
      () =>
        new Promise<(typeof publication)[]>((resolve) => {
          resolveCandidates = resolve;
        }),
    );
    const reconciler = createPublicationReconciler(input);
    const running = reconciler.reconcileOnce();
    await vi.waitFor(() => expect(input.publications.listQueueCandidates).toHaveBeenCalledOnce());

    const closing = reconciler.close();
    resolveCandidates([publication]);

    await running;
    await closing;
    expect(input.queue.ensurePublicationJob).not.toHaveBeenCalled();
    await expect(reconciler.reconcileOnce()).resolves.toEqual({ queued: 0, recovered: 0 });
  });
});
