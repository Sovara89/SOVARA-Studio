import type { createPublicationRepository } from '@sovara-studio/db';
import type { PublicationPlatform } from '@sovara-studio/db';
import type { createPublicationQueue } from '@sovara-studio/infra';
import { publicationJobId, safeErrorFields } from '@sovara-studio/infra';
import type { PublicationPublisher } from '@sovara-studio/platforms';

type PublicationRepository = ReturnType<typeof createPublicationRepository>;
type PublicationQueue = ReturnType<typeof createPublicationQueue>;

export type PublicationReconcilerDependencies = {
  publications: PublicationRepository;
  queue: PublicationQueue;
  publishers?: ReadonlyMap<string, PublicationPublisher>;
  executors?: ReadonlyMap<string, { executeAfterRequestSent: () => Promise<void> }>;
  intervalMs: number;
  batchSize: number;
  leaseDurationMs: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  shutdownSignal?: AbortSignal;
};

export function createPublicationReconciler(dependencies: PublicationReconcilerDependencies) {
  const log = dependencies.log ?? (() => undefined);
  const publishers = dependencies.publishers ?? new Map<string, PublicationPublisher>();
  const legacyExecutors = dependencies.executors ?? new Map();
  const executionPlatforms = new Set([
    ...legacyExecutors.keys(),
    ...[...publishers.values()]
      .filter((publisher) => Boolean(publisher.publish))
      .map((publisher) => publisher.platform),
  ]);
  const reconcilablePlatforms = new Set(publishers.keys());
  const registeredPlatforms = new Set([...executionPlatforms, ...reconcilablePlatforms]);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let closed = false;
  const stopped = () => closed || dependencies.shutdownSignal?.aborted === true;

  const reconcileOnce = async () => {
    if (running || stopped()) return { queued: 0, recovered: 0 };
    running = true;
    let queued = 0;
    let recovered = 0;
    log('reconciliation_started', {});
    try {
      const expired = await dependencies.publications.listExpiredPublicationLeases(
        dependencies.batchSize,
      );
      for (const publication of expired) {
        if (stopped()) break;
        const [attempt] = await dependencies.publications.findLatestAttemptForUser(
          publication.userId,
          publication.id,
        );
        if (stopped()) break;
        if (!attempt || !publication.leaseToken || !publication.leaseExpiresAt) continue;
        const result = await dependencies.publications.recoverExpiredPublicationLease({
          publicationId: publication.id,
          expectedPublicationRevision: publication.revision,
          expectedLeaseToken: publication.leaseToken,
          expectedAttemptId: attempt.id,
          expectedAttemptRevision: attempt.revision,
          expectedAttemptState:
            attempt.state === 'started' ||
            attempt.state === 'request_sent' ||
            attempt.state === 'ambiguous'
              ? attempt.state
              : 'started',
          retryAt: new Date(),
        });
        if (stopped()) break;
        if (result.outcome !== 'stale') {
          recovered += 1;
          log('lease_recovered', {
            publicationId: publication.id,
            revision: publication.revision,
            outcome: result.outcome,
          });
          if (result.outcome === 'retry_wait' && executionPlatforms.has(publication.platform)) {
            if (stopped()) break;
            await dependencies.queue.ensurePublicationJob({
              publicationId: publication.id,
              expectedRevision: result.publication.revision,
            });
          }
        }
      }

      const executablePlatforms = [...executionPlatforms] as PublicationPlatform[];
      const reconcilerPlatforms = [...reconcilablePlatforms] as PublicationPlatform[];
      if (stopped()) return { queued, recovered };
      const candidates = await dependencies.publications.listQueueCandidates({
        executablePlatforms,
        includeQueued: true,
        includeDueRetryWait: true,
        reconcilablePlatforms: reconcilerPlatforms,
        limit: dependencies.batchSize,
      });
      for (const publication of candidates) {
        if (stopped()) break;
        if (!registeredPlatforms.has(publication.platform)) continue;
        const payload = {
          publicationId: publication.id,
          expectedRevision: publication.revision,
        };
        await dependencies.queue.ensurePublicationJob(payload);
        queued += 1;
      }
      log('reconciliation_completed', { queued, recovered });
      return { queued, recovered };
    } finally {
      running = false;
    }
  };

  return {
    reconcileOnce,
    start: async () => {
      if (stopped()) return;
      await reconcileOnce();
      if (stopped()) return;
      timer = setInterval(() => {
        void reconcileOnce().catch((error) => log('reconciliation_failed', safeErrorFields(error)));
      }, dependencies.intervalMs);
    },
    close: async () => {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

export function publicationJobKey(publicationId: string, revision: number) {
  return publicationJobId({ publicationId, expectedRevision: revision });
}
