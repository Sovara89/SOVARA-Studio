import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queueClose: vi.fn(),
  workerClose: vi.fn(),
  redisClients: [] as Array<{
    status: string;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(function Queue() {
    return { close: mocks.queueClose };
  }),
  Worker: vi.fn(function Worker() {
    return { close: mocks.workerClose };
  }),
}));

vi.mock('./factories.js', () => ({
  createRedisUrlClient: vi.fn(() => {
    const redis = mocks.redisClients.shift();
    if (!redis) throw new Error('Missing mocked Redis client');
    return redis;
  }),
}));

import { createPublicationQueue, createPublicationWorker } from './publication-queue.js';

const configuration = {
  redisUrl: 'redis://test',
  queueName: 'publications',
  prefix: 'test',
  jobAttempts: 3,
  backoffMs: 100,
  lockDurationMs: 30_000,
  stalledIntervalMs: 10_000,
  maxStalledCount: 1,
  completedRetentionSeconds: 60,
  failedRetentionSeconds: 60,
  connectionTimeoutMs: 1_000,
};

function addRedis() {
  const redis = {
    status: 'ready',
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  };
  mocks.redisClients.push(redis);
  return redis;
}

describe('publication queue resource close wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisClients.length = 0;
  });

  test('queue close caches one promise across concurrent and later calls', async () => {
    const redis = addRedis();
    let resolveBullMqClose!: () => void;
    mocks.queueClose.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveBullMqClose = resolve;
      }),
    );
    const publicationQueue = createPublicationQueue(configuration);

    const first = publicationQueue.close();
    const concurrent = publicationQueue.close();
    expect(concurrent).toBe(first);
    expect(mocks.queueClose).toHaveBeenCalledOnce();
    expect(redis.quit).not.toHaveBeenCalled();

    resolveBullMqClose();
    await first;
    expect(redis.quit).toHaveBeenCalledOnce();
    expect(publicationQueue.close()).toBe(first);
    expect(mocks.queueClose).toHaveBeenCalledOnce();
    expect(redis.quit).toHaveBeenCalledOnce();
  });

  test('queue close observes BullMQ failure but still quits Redis', async () => {
    const redis = addRedis();
    const bullMqError = new Error('queue close rejected');
    mocks.queueClose.mockRejectedValue(bullMqError);
    const publicationQueue = createPublicationQueue(configuration);

    const first = publicationQueue.close();
    expect(publicationQueue.close()).toBe(first);
    const result = await first.catch((error: unknown) => error);

    expect(redis.quit).toHaveBeenCalledOnce();
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([bullMqError]);
  });

  test('worker close caches the first force mode and one promise across concurrent calls', async () => {
    const redis = addRedis();
    let resolveBullMqClose!: () => void;
    mocks.workerClose.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveBullMqClose = resolve;
      }),
    );
    const publicationWorker = createPublicationWorker(
      { ...configuration, workerConcurrency: 2 },
      async () => undefined,
    );

    const first = publicationWorker.close(true);
    const concurrent = publicationWorker.close(false);
    expect(concurrent).toBe(first);
    expect(mocks.workerClose).toHaveBeenCalledOnce();
    expect(mocks.workerClose).toHaveBeenCalledWith(true);

    resolveBullMqClose();
    await first;
    expect(redis.quit).toHaveBeenCalledOnce();
    expect(publicationWorker.close()).toBe(first);
  });

  test('worker close observes BullMQ and Redis failures and force-disconnects Redis', async () => {
    const redis = addRedis();
    const bullMqError = new Error('worker close rejected');
    const redisError = new Error('redis quit rejected');
    mocks.workerClose.mockRejectedValue(bullMqError);
    redis.quit.mockRejectedValue(redisError);
    const publicationWorker = createPublicationWorker(
      { ...configuration, workerConcurrency: 2 },
      async () => undefined,
    );

    const first = publicationWorker.close(true);
    expect(publicationWorker.close()).toBe(first);
    const result = await first.catch((error: unknown) => error);

    expect(redis.quit).toHaveBeenCalledOnce();
    expect(redis.disconnect).toHaveBeenCalledOnce();
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([bullMqError, redisError]);
  });
});
