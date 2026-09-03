import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPublicationQueue, publicationJobId } from '../../packages/infra/dist/index.js';

const queueConfiguration = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:16379',
  queueName: process.env.PUBLICATION_QUEUE_NAME ?? 'sovara-publications',
  prefix: process.env.BULLMQ_PREFIX ?? 'sovara-studio',
  jobAttempts: 2,
  backoffMs: 100,
  lockDurationMs: 5_000,
  stalledIntervalMs: 1_000,
  maxStalledCount: 1,
  completedRetentionSeconds: 3_600,
  failedRetentionSeconds: 3_600,
  connectionTimeoutMs: 2_000,
};

const publicationId = randomUUID();

describe('publication queue and independent worker', () => {
  const queue = createPublicationQueue(queueConfiguration);

  beforeAll(async () => {
    await queue.queue.waitUntilReady();
  });

  afterAll(async () => {
    await queue.close();
  });

  test('processes a minimal job and requeues a completed revision deterministically', async () => {
    const payload = { publicationId, expectedRevision: 0 };
    const first = await queue.ensurePublicationJob(payload);
    expect(first).toMatchObject({
      jobId: publicationJobId(payload),
      state: 'waiting',
      action: 'created',
    });

    const deadline = Date.now() + 10_000;
    let completed = false;
    while (Date.now() < deadline) {
      const job = await queue.queue.getJob(first.jobId);
      completed = (await job?.getState()) === 'completed';
      if (completed) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(completed).toBe(true);

    const requeued = await queue.ensurePublicationJob(payload);
    expect(requeued).toMatchObject({
      jobId: first.jobId,
      state: 'waiting',
      action: 'requeued',
    });
  });
});
