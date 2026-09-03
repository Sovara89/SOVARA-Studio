import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job, type QueueOptions } from 'bullmq';
import {
  publicationJobName,
  publicationJobPayloadSchema,
  type PublicationJobPayload,
} from '@sovara-studio/contracts';
import { createRedisUrlClient } from './factories.js';
import type { RedisClient } from './factories.js';

export type PublicationQueueConfiguration = {
  redisUrl: string;
  queueName: string;
  prefix: string;
  jobAttempts: number;
  backoffMs: number;
  lockDurationMs: number;
  stalledIntervalMs: number;
  maxStalledCount: number;
  completedRetentionSeconds: number;
  failedRetentionSeconds: number;
  connectionTimeoutMs: number;
};

export type PublicationJobState =
  'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown';

export type EnsurePublicationJobResult = {
  jobId: string;
  state: PublicationJobState;
  action: 'created' | 'existing' | 'requeued' | 'locked';
};

const unlockScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export function publicationJobId(payload: PublicationJobPayload) {
  return `publication-${publicationJobPayloadSchema.parse(payload).publicationId}-r${payload.expectedRevision}`;
}

function mapJobState(state: string): PublicationJobState {
  if (
    state === 'waiting' ||
    state === 'delayed' ||
    state === 'active' ||
    state === 'completed' ||
    state === 'failed'
  )
    return state;
  return 'unknown';
}

async function closeBullMqAndRedis(
  closeBullMq: () => Promise<unknown>,
  redis: RedisClient,
  failureMessage: string,
) {
  const failures: unknown[] = [];
  try {
    await closeBullMq();
  } catch (error) {
    failures.push(error);
  }

  if (redis.status !== 'end') {
    try {
      await redis.quit();
    } catch (error) {
      failures.push(error);
      // A rejected graceful quit must not leave a live socket behind.
      try {
        redis.disconnect();
      } catch (disconnectError) {
        failures.push(disconnectError);
      }
    }
  }

  if (failures.length > 0) throw new AggregateError(failures, failureMessage);
}

export function createPublicationQueue(configuration: PublicationQueueConfiguration) {
  const redis = createRedisUrlClient(
    configuration.redisUrl,
    'producer',
    configuration.connectionTimeoutMs,
  );
  const queueOptions: QueueOptions = {
    connection: redis,
    prefix: configuration.prefix,
    defaultJobOptions: {
      attempts: configuration.jobAttempts,
      backoff: { type: 'exponential', delay: configuration.backoffMs },
      removeOnComplete: { age: configuration.completedRetentionSeconds, count: 1_000 },
      removeOnFail: { age: configuration.failedRetentionSeconds, count: 1_000 },
    },
  };
  const queue = new Queue<PublicationJobPayload, unknown, typeof publicationJobName>(
    configuration.queueName,
    queueOptions,
  );
  let closePromise: Promise<void> | undefined;

  const ensurePublicationJob = async (
    payload: PublicationJobPayload,
  ): Promise<EnsurePublicationJobResult> => {
    const parsed = publicationJobPayloadSchema.parse(payload);
    const jobId = publicationJobId(parsed);
    const lockKey = `${configuration.prefix}:publication-job-reconcile:${jobId}`;
    const lockToken = randomUUID();
    const acquired = await redis.set(lockKey, lockToken, 'PX', configuration.lockDurationMs, 'NX');
    if (acquired !== 'OK') return { jobId, state: 'unknown', action: 'locked' };
    try {
      const existing = await queue.getJob(jobId);
      if (!existing) {
        await queue.add(publicationJobName, parsed, { jobId });
        return { jobId, state: 'waiting', action: 'created' };
      }
      const state = mapJobState(await existing.getState());
      if (state === 'waiting' || state === 'delayed' || state === 'active')
        return { jobId, state, action: 'existing' };
      if (state === 'failed') {
        await existing.retry('failed');
        return { jobId, state: 'waiting', action: 'requeued' };
      }
      if (state === 'completed') {
        await existing.remove();
        await queue.add(publicationJobName, parsed, { jobId });
        return { jobId, state: 'waiting', action: 'requeued' };
      }
      await queue.add(publicationJobName, parsed, { jobId });
      return { jobId, state: 'waiting', action: 'created' };
    } finally {
      await redis.eval(unlockScript, 1, lockKey, lockToken).catch(() => undefined);
    }
  };

  return {
    queue,
    redis,
    ensurePublicationJob,
    close: () => {
      closePromise ??= closeBullMqAndRedis(
        () => queue.close(),
        redis,
        'Publication queue close failed',
      );
      return closePromise;
    },
  };
}

export type PublicationWorkerConfiguration = Pick<
  PublicationQueueConfiguration,
  | 'redisUrl'
  | 'queueName'
  | 'prefix'
  | 'lockDurationMs'
  | 'stalledIntervalMs'
  | 'maxStalledCount'
  | 'connectionTimeoutMs'
> & { workerConcurrency: number; autorun?: boolean };

export type PublicationProcessor = (job: Job<PublicationJobPayload>) => Promise<unknown>;

export function createPublicationWorker(
  configuration: PublicationWorkerConfiguration,
  processor: PublicationProcessor,
) {
  const redis = createRedisUrlClient(
    configuration.redisUrl,
    'worker',
    configuration.connectionTimeoutMs,
  );
  const worker = new Worker<PublicationJobPayload, unknown, typeof publicationJobName>(
    configuration.queueName,
    processor,
    {
      connection: redis,
      prefix: configuration.prefix,
      concurrency: configuration.workerConcurrency,
      lockDuration: configuration.lockDurationMs,
      stalledInterval: configuration.stalledIntervalMs,
      maxStalledCount: configuration.maxStalledCount,
      // Existing direct consumers retain BullMQ's autorun default. The production runtime opts
      // out so its startup lifecycle can own the intake gate.
      autorun: configuration.autorun ?? true,
    },
  );
  let closePromise: Promise<void> | undefined;
  return {
    worker,
    redis,
    close: (force = false) => {
      closePromise ??= closeBullMqAndRedis(
        () => worker.close(force),
        redis,
        'Publication worker close failed',
      );
      return closePromise;
    },
  };
}
