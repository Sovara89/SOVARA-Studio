import {
  createDatabase,
  createPublicationRepository,
  createPublishingAccountRepository,
  createVideoRepository,
} from '@sovara-studio/db';
import {
  createPublishingCredentialService,
  createPublicationQueue,
  createPublicationWorker,
  createRedisUrlClient,
  createS3Client,
  createS3MediaSource,
  parseCredentialKeyring,
} from '@sovara-studio/infra';
import {
  createYouTubeOAuthProvider,
  createYouTubePublisher,
  createVkOAuthProvider,
  createVKVideoPublisher,
  type PublicationPublisher,
} from '@sovara-studio/platforms';
import { environment } from './env';
import { createPublicationJobProcessor } from './publication-job-processor';
import { createPublicationReconciler } from './publication-reconciler';
import { createPublicationPreflight } from './publication-preflight';

export interface WorkerDependency {
  ping: () => Promise<string>;
  quit: () => Promise<unknown>;
}

export interface WorkerRuntime {
  redis: WorkerDependency;
  shutdownSignal: AbortSignal;
  /** Rejects only when an authoritative background runtime exits unexpectedly. */
  failure: Promise<never>;
  requestShutdown: (reason?: unknown) => void;
  close: () => Promise<void>;
}

type WorkerCloseObservation = { status: 'fulfilled' } | { status: 'rejected'; error: unknown };

export type PublicationRuntimeTeardownDependencies = {
  reconcilerClose: () => Promise<unknown>;
  pauseWorker: () => Promise<unknown>;
  closeWorker: (force?: boolean) => Promise<unknown>;
  waitForHandlers: () => Promise<void>;
  closeQueue: () => Promise<unknown>;
  closeDatabase: () => Promise<unknown>;
  destroyStorage: () => void;
  shutdownTimeoutMs: number;
  log?: (event: string) => void;
};

export type PartialPublicationStartupCleanupDependencies = {
  closeWorker: () => Promise<unknown>;
  closeQueue: () => Promise<unknown>;
  closeDatabase: () => Promise<unknown>;
  destroyStorage: () => void;
};

export type PublicationWorkerRunLoopDependencies = {
  run: () => Promise<unknown>;
  shutdownSignal: AbortSignal;
  close: () => Promise<void>;
};

const waitForever = new Promise<never>(() => undefined);

/**
 * Observes BullMQ's complete run-loop lifetime. An unexpected settlement first enters the
 * existing teardown path synchronously; the returned failure then lets the process lifecycle
 * close health and report a non-zero terminal failure. A run loop settling after shutdown is an
 * expected BullMQ termination and deliberately leaves the failure promise pending.
 */
export function observePublicationWorkerRunLoop(
  dependencies: PublicationWorkerRunLoopDependencies,
): Promise<never> {
  const fail = (reason: unknown): Promise<never> => {
    if (dependencies.shutdownSignal.aborted) return waitForever;

    const primary =
      reason instanceof Error
        ? reason
        : new Error('Publication worker run loop failed', { cause: reason });
    let closing: Promise<void>;
    try {
      // createPublicationRuntimeTeardown.close() aborts the provider/reconciler gate before its
      // first await and is idempotent when the process lifecycle subsequently joins teardown.
      closing = dependencies.close();
    } catch (cleanupError) {
      return Promise.reject(
        new AggregateError(
          [primary, cleanupError],
          'Publication worker run loop failed and shutdown could not start',
        ),
      );
    }
    // The process lifecycle will join this same cached close promise. Observe it here as well so
    // even a consumer that delays attaching to failure cannot create an unhandled rejection.
    void closing.catch(() => undefined);
    return Promise.reject(primary);
  };

  let running: Promise<unknown>;
  try {
    running = dependencies.run();
  } catch (error) {
    const failure = fail(error);
    void failure.catch(() => undefined);
    return failure;
  }

  const failure = running.then(
    () => fail(new Error('Publication worker run loop exited unexpectedly')),
    (error: unknown) => fail(error),
  );
  void failure.catch(() => undefined);
  return failure;
}

/** Cleans resources created before the complete runtime teardown can be assembled. */
export function createPartialPublicationStartupCleanup(
  dependencies: PartialPublicationStartupCleanupDependencies,
) {
  let cleanupPromise: Promise<void> | undefined;
  return () => {
    cleanupPromise ??= (async () => {
      const failures: unknown[] = [];
      const attempt = async (operation: () => void | Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      await attempt(dependencies.closeWorker);
      await attempt(dependencies.closeQueue);
      await attempt(dependencies.closeDatabase);
      await attempt(dependencies.destroyStorage);
      if (failures.length > 0)
        throw new AggregateError(failures, 'Partial worker startup cleanup failed');
    })();
    return cleanupPromise;
  };
}

/**
 * Owns the runtime shutdown signal and enforces the resource lifetime boundary: provider
 * handlers quiesce before the shared S3 client, database, and queue are torn down.
 */
export function createPublicationRuntimeTeardown(
  dependencies: PublicationRuntimeTeardownDependencies,
  controller = new AbortController(),
) {
  let closePromise: Promise<void> | undefined;
  const requestShutdown = (reason: unknown = new Error('worker runtime shutting down')) => {
    controller.abort(reason);
  };
  const close = () => {
    // This gate is intentionally outside the async teardown body. Callers can synchronously stop
    // provider dispatch and reconciliation before they await any process-level shutdown work.
    requestShutdown();
    closePromise ??= (async () => {
      const failures: unknown[] = [];
      const attempt = async (operation: () => void | Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };

      dependencies.log?.('shutdown_started');
      await attempt(dependencies.reconcilerClose);
      await attempt(dependencies.pauseWorker);

      // BullMQ caches the first close() promise and its force argument. A timed-out graceful
      // close(false) therefore cannot be escalated by calling close(true): the second call only
      // returns the original pending promise. Force-close exactly once, then use our independently
      // tracked handlers as the authoritative quiescence boundary.
      const workerClose = Promise.resolve()
        .then(() => dependencies.closeWorker(true))
        .then<WorkerCloseObservation, WorkerCloseObservation>(
          () => ({ status: 'fulfilled' }),
          (error: unknown) => ({ status: 'rejected', error }),
        );
      let timeout: NodeJS.Timeout | undefined;
      const firstObservation = await Promise.race([
        workerClose,
        new Promise<'timed_out'>((resolve) => {
          timeout = setTimeout(() => resolve('timed_out'), dependencies.shutdownTimeoutMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (firstObservation === 'timed_out') {
        failures.push(new Error('Worker force-close timed out'));
        // A BullMQ Worker caches its first close promise (including the force mode). Never detach
        // that promise or release its Redis/shared dependencies after a diagnostic timeout. The
        // rejection-mapping above observes a late rejection immediately; this await establishes
        // the real resource boundary.
        const finalObservation = await workerClose;
        if (finalObservation.status === 'rejected') failures.push(finalObservation.error);
      } else if (firstObservation.status === 'rejected') {
        failures.push(firstObservation.error);
      }

      // BullMQ force-close deliberately does not wait for active handlers. Do not release any
      // shared dependency until the operation-owned provider cleanup and handler finally blocks
      // have actually completed.
      await attempt(dependencies.waitForHandlers);
      await attempt(dependencies.closeQueue);
      await attempt(dependencies.closeDatabase);
      await attempt(dependencies.destroyStorage);
      dependencies.log?.('shutdown_completed');
      if (failures.length > 0) throw new AggregateError(failures, 'Worker shutdown failed');
    })();
    return closePromise;
  };
  return { signal: controller.signal, requestShutdown, close };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function startWorker(
  redisFactory: () => WorkerDependency = () =>
    createRedisUrlClient(environment.REDIS_URL, 'worker'),
): Promise<WorkerRuntime> {
  const redis = redisFactory();
  try {
    await redis.ping();
  } catch (error) {
    await redis.quit().catch(() => undefined);
    throw error;
  }
  const shutdownController = new AbortController();
  let closePromise: Promise<void> | undefined;
  return {
    redis,
    shutdownSignal: shutdownController.signal,
    failure: waitForever,
    requestShutdown: (reason) => shutdownController.abort(reason),
    close: () => {
      shutdownController.abort(new Error('worker runtime shutting down'));
      return (closePromise ??= Promise.resolve(redis.quit()).then(() => undefined));
    },
  };
}

export async function startPublicationWorker(startupSignal?: AbortSignal): Promise<WorkerRuntime> {
  const shutdownController = new AbortController();
  const forwardStartupAbort = () => shutdownController.abort(startupSignal?.reason);
  if (startupSignal?.aborted) forwardStartupAbort();
  else startupSignal?.addEventListener('abort', forwardStartupAbort, { once: true });
  const assertStartupOpen = () => {
    if (shutdownController.signal.aborted)
      throw shutdownController.signal.reason instanceof Error
        ? shutdownController.signal.reason
        : new Error('Worker startup aborted');
  };
  let closePartialWorker: () => Promise<unknown> = async () => undefined;
  let closePartialQueue: () => Promise<unknown> = async () => undefined;
  let closePartialDatabase: () => Promise<unknown> = async () => undefined;
  let destroyPartialStorage: () => void = () => undefined;
  const cleanupPartialStartup = createPartialPublicationStartupCleanup({
    closeWorker: () => closePartialWorker(),
    closeQueue: () => closePartialQueue(),
    closeDatabase: () => closePartialDatabase(),
    destroyStorage: () => destroyPartialStorage(),
  });
  let teardown: ReturnType<typeof createPublicationRuntimeTeardown> | undefined;
  let runtimeOwnsAbortForwarding = false;
  try {
    assertStartupOpen();
    if (!environment.CREDENTIAL_ENCRYPTION_KEYS || !environment.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID)
      throw new Error('Worker credential encryption configuration is required');
    const keyring = parseCredentialKeyring(environment.CREDENTIAL_ENCRYPTION_KEYS);
    const youtubeConfiguration = [
      environment.YOUTUBE_CLIENT_ID,
      environment.YOUTUBE_CLIENT_SECRET,
      environment.YOUTUBE_REDIRECT_URI,
    ];
    if (youtubeConfiguration.some(Boolean) && youtubeConfiguration.some((value) => !value))
      throw new Error('YouTube OAuth configuration is incomplete');
    const database = createDatabase(environment.DATABASE_URL);
    closePartialDatabase = () => database.pool.end();
    const publications = createPublicationRepository(database.db);
    const accounts = createPublishingAccountRepository(database.db);
    const videos = createVideoRepository(database.db);
    const storage = createS3Client({
      endpoint: environment.S3_ENDPOINT,
      region: environment.S3_REGION,
      accessKeyId: environment.S3_ACCESS_KEY_ID,
      secretAccessKey: environment.S3_SECRET_ACCESS_KEY,
      forcePathStyle: environment.S3_FORCE_PATH_STYLE,
      maxAttempts: 1,
    });
    destroyPartialStorage = () => storage.destroy();
    const providers =
      environment.YOUTUBE_CLIENT_ID &&
      environment.YOUTUBE_CLIENT_SECRET &&
      environment.YOUTUBE_REDIRECT_URI
        ? {
            youtube: createYouTubeOAuthProvider({
              clientId: environment.YOUTUBE_CLIENT_ID,
              clientSecret: environment.YOUTUBE_CLIENT_SECRET,
              redirectUri: environment.YOUTUBE_REDIRECT_URI,
            }),
          }
        : {};
    if (
      environment.VK_CLIENT_ID &&
      environment.VK_SERVICE_TOKEN &&
      environment.VK_REDIRECT_URI &&
      environment.VK_GROUP_ID
    )
      Object.assign(providers, {
        vk: createVkOAuthProvider({
          clientId: environment.VK_CLIENT_ID,
          serviceToken: environment.VK_SERVICE_TOKEN,
          redirectUri: environment.VK_REDIRECT_URI,
        }),
      });
    const credentials = createPublishingCredentialService({
      database,
      credentialConfiguration: {
        keyring,
        activeKeyId: environment.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
      },
      providers,
    });
    const preflight = createPublicationPreflight({
      accounts,
      videos,
      credentials,
      createMediaSource: (video) => {
        if (video.verifiedSizeBytes === null) throw new Error('Verified video size is required');
        return createS3MediaSource({
          client: storage,
          bucket: video.storageBucket,
          objectKey: video.objectKey,
          sizeBytes: video.verifiedSizeBytes,
          contentType: video.contentType,
          expectedEtag: video.objectEtag,
        });
      },
    });
    const youtubePublisher = createYouTubePublisher({
      chunkSizeBytes: environment.YOUTUBE_UPLOAD_CHUNK_BYTES,
      maxStatusProbes: environment.YOUTUBE_MAX_STATUS_PROBES,
    });
    const publishers = new Map<string, PublicationPublisher>([['youtube', youtubePublisher]]);
    if (
      environment.VK_CLIENT_ID &&
      environment.VK_SERVICE_TOKEN &&
      environment.VK_REDIRECT_URI &&
      environment.VK_GROUP_ID
    )
      publishers.set(
        'vk',
        createVKVideoPublisher({
          groupId: environment.VK_GROUP_ID,
          capabilityTimeoutMs: environment.VK_CAPABILITY_TIMEOUT_MS,
          saveTimeoutMs: environment.VK_SAVE_TIMEOUT_MS,
          getTimeoutMs: environment.VK_GET_TIMEOUT_MS,
          dnsTimeoutMs: environment.VK_DNS_TIMEOUT_MS,
          uploadTimeoutMs: environment.VK_UPLOAD_TIMEOUT_MS,
          responseReadTimeoutMs: environment.VK_RESPONSE_READ_TIMEOUT_MS,
        }),
      );
    const queue = createPublicationQueue({
      redisUrl: environment.REDIS_URL,
      queueName: environment.PUBLICATION_QUEUE_NAME,
      prefix: environment.BULLMQ_PREFIX,
      jobAttempts: environment.PUBLICATION_JOB_ATTEMPTS,
      backoffMs: environment.PUBLICATION_JOB_BACKOFF_MS,
      lockDurationMs: environment.PUBLICATION_LEASE_MS,
      stalledIntervalMs: Math.min(30_000, environment.PUBLICATION_LEASE_MS / 2),
      maxStalledCount: 1,
      completedRetentionSeconds: environment.PUBLICATION_COMPLETED_RETENTION_SECONDS,
      failedRetentionSeconds: environment.PUBLICATION_FAILED_RETENTION_SECONDS,
      connectionTimeoutMs: environment.WORKER_STARTUP_TIMEOUT_MS,
    });
    closePartialQueue = () => queue.close();
    const reconciler = createPublicationReconciler({
      publications,
      queue,
      publishers,
      intervalMs: environment.PUBLICATION_RECONCILE_INTERVAL_MS,
      batchSize: environment.PUBLICATION_RECONCILE_BATCH_SIZE,
      leaseDurationMs: environment.PUBLICATION_LEASE_MS,
      shutdownSignal: shutdownController.signal,
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    });
    const processor = createPublicationJobProcessor({
      publications,
      publishers,
      preflight,
      leaseDurationMs: environment.PUBLICATION_LEASE_MS,
      leaseHeartbeatMs: environment.PUBLICATION_LEASE_HEARTBEAT_MS,
      shutdownSignal: shutdownController.signal,
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    });
    const publicationWorker = createPublicationWorker(
      {
        redisUrl: environment.REDIS_URL,
        queueName: environment.PUBLICATION_QUEUE_NAME,
        prefix: environment.BULLMQ_PREFIX,
        workerConcurrency: environment.PUBLICATION_WORKER_CONCURRENCY,
        lockDurationMs: environment.PUBLICATION_LEASE_MS,
        stalledIntervalMs: Math.min(30_000, environment.PUBLICATION_LEASE_MS / 2),
        maxStalledCount: 1,
        connectionTimeoutMs: environment.WORKER_STARTUP_TIMEOUT_MS,
        autorun: false,
      },
      processor,
    );
    closePartialWorker = () => publicationWorker.close(true);
    teardown = createPublicationRuntimeTeardown(
      {
        reconcilerClose: () => reconciler.close(),
        pauseWorker: () => publicationWorker.worker.pause(true),
        closeWorker: (force) => publicationWorker.close(force),
        waitForHandlers: () => processor.waitForIdle(),
        closeQueue: () => queue.close(),
        closeDatabase: () => database.pool.end(),
        destroyStorage: () => storage.destroy(),
        shutdownTimeoutMs: environment.WORKER_SHUTDOWN_TIMEOUT_MS,
        log: (event) => console.log(JSON.stringify({ event })),
      },
      shutdownController,
    );
    const runtimeTeardown = teardown;
    const startupStep = async (operation: () => Promise<unknown>, timeoutMessage: string) => {
      assertStartupOpen();
      await withTimeout(operation(), environment.WORKER_STARTUP_TIMEOUT_MS, timeoutMessage);
      assertStartupOpen();
    };
    await startupStep(() => database.pool.query('select 1'), 'Database startup timed out');
    await startupStep(() => queue.redis.ping(), 'Redis startup timed out');
    await startupStep(() => queue.queue.waitUntilReady(), 'BullMQ queue startup timed out');
    await startupStep(
      () => publicationWorker.worker.waitUntilReady(),
      'BullMQ worker startup timed out',
    );
    await startupStep(() => reconciler.start(), 'Publication reconciliation startup timed out');
    assertStartupOpen();
    // Worker was constructed with autorun=false. There is no await between this final monotonic
    // gate and run(), so a startup signal cannot win a check/use race and still permit intake.
    const runtimeFailure = observePublicationWorkerRunLoop({
      run: () => publicationWorker.worker.run(),
      shutdownSignal: shutdownController.signal,
      close: () => runtimeTeardown.close(),
    });
    console.log(JSON.stringify({ event: 'worker_started' }));
    runtimeOwnsAbortForwarding = true;
    let closePromise: Promise<void> | undefined;
    return {
      redis: queue.redis,
      shutdownSignal: shutdownController.signal,
      failure: runtimeFailure,
      requestShutdown: runtimeTeardown.requestShutdown,
      close: () => {
        closePromise ??= runtimeTeardown.close().finally(() => {
          startupSignal?.removeEventListener('abort', forwardStartupAbort);
        });
        return closePromise;
      },
    };
  } catch (error) {
    shutdownController.abort(error);
    try {
      if (teardown) await teardown.close();
      else await cleanupPartialStartup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Worker startup and cleanup failed');
    }
    throw error;
  } finally {
    // After successful startup this forwarding link belongs to the returned runtime and remains
    // installed until close settles. A process signal must continue to reach active provider and
    // reconciler operations throughout the fully-started runtime lifetime.
    if (!runtimeOwnsAbortForwarding)
      startupSignal?.removeEventListener('abort', forwardStartupAbort);
  }
}

export function createWorkerRuntime(redis: WorkerDependency): WorkerRuntime {
  const shutdownController = new AbortController();
  let closePromise: Promise<void> | undefined;
  return {
    redis,
    shutdownSignal: shutdownController.signal,
    failure: waitForever,
    requestShutdown: (reason) => shutdownController.abort(reason),
    close: () => {
      shutdownController.abort(new Error('worker runtime shutting down'));
      return (closePromise ??= Promise.resolve(redis.quit()).then(() => undefined));
    },
  };
}
