import type { Job } from 'bullmq';
import { publicationJobPayloadSchema, type PublicationJobPayload } from '@sovara-studio/contracts';
import type { createPublicationRepository } from '@sovara-studio/db';
import type {
  PublicationContext,
  PublicationPublisher,
  ReconciliationContext,
  PublishOutcome,
  ProviderEvidence,
  PublicationCredentialSnapshot,
} from '@sovara-studio/platforms';
import { normalizePublishOutcome } from '@sovara-studio/platforms';
import { startPublicationLeaseHeartbeat } from './publication-lease-heartbeat.js';
import {
  calculateReconciliationAt,
  calculateRetryAt,
  reconciliationExpired,
  type PublicationRetryPolicyConfig,
} from './publication-retry-policy.js';
import {
  PublicationPreflightError,
  type PublicationPreflightResult,
} from './publication-preflight.js';

type PublicationRepository = ReturnType<typeof createPublicationRepository>;
type PublicationRow = Awaited<ReturnType<PublicationRepository['findById']>>[number];
type PublicationAttemptRow = Awaited<
  ReturnType<PublicationRepository['findLatestAttemptForUser']>
>[number];

export type PublicationPreflight = (
  publication: PublicationRow,
  signal: AbortSignal,
) => Promise<PublicationPreflightResult>;

type LegacyExecutor = {
  executeAfterRequestSent: (
    context: PublicationContext & {
      attempt: PublicationAttemptRow;
      settleSuccess: (
        remoteOwnerId: string | null | undefined,
        remoteMediaId: string,
        remoteUrl?: string | null,
      ) => Promise<void>;
      markAmbiguous: () => Promise<void>;
    },
  ) => Promise<void>;
};

export type PublicationJobProcessorDependencies = {
  publications: PublicationRepository;
  publishers?: ReadonlyMap<string, PublicationPublisher>;
  executors?: ReadonlyMap<string, LegacyExecutor>;
  preflight?: PublicationPreflight;
  legacyCredentialOwnership?: (publication: PublicationRow) => {
    accountId: string;
    userId: string;
    platform: 'youtube' | 'vk';
    credentialRevision: number;
  };
  leaseDurationMs: number;
  leaseHeartbeatMs: number;
  retryPolicy?: PublicationRetryPolicyConfig;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Aborts provider and preflight work when the worker runtime is shutting down. */
  shutdownSignal?: AbortSignal;
};

export type PublicationJobProcessor = ((job: Job<PublicationJobPayload>) => Promise<unknown>) & {
  /** Resolves only after every handler which entered this processor has settled. */
  waitForIdle(): Promise<void>;
};

function contextBase(
  publication: PublicationRow,
  attempt: PublicationAttemptRow,
  credential: PublicationPreflightResult['credential'],
  media: PublicationPreflightResult['media'] | undefined,
  signal: AbortSignal,
  evidence: ProviderEvidence,
  checkpointEvidence: (input: ProviderEvidence) => Promise<void>,
  reportProgress?: (progress: { uploadedBytes: number; totalBytes: number }) => void,
) {
  return {
    publicationId: publication.id,
    attemptId: attempt.id,
    operationKey: attempt.id,
    platform: publication.platform as 'youtube' | 'vk',
    title: publication.title,
    description: publication.description,
    metadata: (publication.metadata ?? {}) as Record<string, unknown>,
    credential,
    media,
    signal,
    evidence,
    checkpointEvidence,
    reportProgress,
  };
}

function evidenceFromAttempt(attempt: PublicationAttemptRow): ProviderEvidence {
  return {
    ...(attempt.providerRequestId ? { providerRequestId: attempt.providerRequestId } : {}),
    ...(attempt.remoteOwnerId ? { remoteOwnerId: attempt.remoteOwnerId } : {}),
    ...(attempt.remoteMediaId ? { remoteMediaId: attempt.remoteMediaId } : {}),
    ...(attempt.remoteUrl ? { remoteUrl: attempt.remoteUrl } : {}),
  };
}

function isCredentialSnapshot(value: unknown): value is PublicationCredentialSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<PublicationCredentialSnapshot>;
  const credentialRevision = snapshot.credentialRevision;
  return (
    typeof snapshot.accountId === 'string' &&
    typeof snapshot.userId === 'string' &&
    (snapshot.platform === 'youtube' || snapshot.platform === 'vk') &&
    Number.isSafeInteger(credentialRevision) &&
    (credentialRevision as number) >= 0 &&
    typeof snapshot.accessToken === 'string' &&
    snapshot.accessToken.length > 0 &&
    typeof snapshot.providerAccountId === 'string' &&
    snapshot.providerAccountId.length > 0 &&
    Array.isArray(snapshot.scopes) &&
    typeof snapshot.getAccessToken === 'function'
  );
}

export function createPublicationJobProcessor(
  dependencies: PublicationJobProcessorDependencies,
): PublicationJobProcessor {
  const now = dependencies.now ?? (() => new Date());
  const publishers = dependencies.publishers ?? new Map<string, PublicationPublisher>();
  const legacyExecutors = dependencies.executors ?? new Map<string, LegacyExecutor>();
  const log = dependencies.log ?? (() => undefined);
  const retryPolicy = dependencies.retryPolicy ?? {
    maxProviderAttempts: 5,
    baseDelayMs: 5_000,
    maxDelayMs: 3_600_000,
    maxRetryWindowMs: 7 * 24 * 60 * 60_000,
    reconciliationDelayMs: 30_000,
    reconciliationMaxAgeMs: 24 * 60 * 60_000,
    maxProviderRetryAfterMs: 3_600_000,
  };
  const runtimeIsShuttingDown = () => dependencies.shutdownSignal?.aborted === true;

  const settlePreflightFailure = async (
    publication: PublicationRow,
    attempt: PublicationAttemptRow,
    lease: { expectedLeaseToken: string },
    preflight: PublicationPreflightError,
  ) => {
    const retryAt =
      preflight.disposition === 'retryable'
        ? calculateRetryAt(
            {
              attemptId: attempt.id,
              attemptCount: publication.retryCycleAttemptCount,
              createdAt: publication.retryCycleStartedAt,
              now: now(),
            },
            retryPolicy,
          )
        : null;
    await dependencies.publications.settleDefinitiveFailure(
      publication.userId,
      publication.id,
      attempt.id,
      attempt.revision,
      publication.revision,
      'started',
      {
        failureClass: 'preflight',
        failureCode: preflight.code,
        failureMessage: null,
        retryable: preflight.disposition === 'retryable' && retryAt !== null,
        ...(retryAt ? { nextAttemptAt: retryAt } : {}),
      },
      lease,
    );
  };

  const settlePublishOutcome = async (
    publication: PublicationRow,
    attempt: PublicationAttemptRow,
    attemptRevision: () => number,
    lease: { expectedLeaseToken: string },
    outcome: PublishOutcome,
  ) => {
    if (outcome.kind === 'published') {
      await dependencies.publications.settleDefinitiveSuccess(
        publication.userId,
        publication.id,
        attempt.id,
        attemptRevision(),
        publication.revision,
        outcome.remote.remoteOwnerId,
        outcome.remote.remoteMediaId,
        outcome.remote.remoteUrl,
        lease,
      );
      return;
    }
    if (outcome.kind === 'ambiguous') {
      await dependencies.publications.markAmbiguous(
        publication.userId,
        publication.id,
        attempt.id,
        attemptRevision(),
        publication.revision,
        lease,
      );
      return;
    }
    const retryAt =
      outcome.disposition === 'retryable'
        ? calculateRetryAt(
            {
              attemptId: attempt.id,
              attemptCount: publication.retryCycleAttemptCount,
              createdAt: publication.retryCycleStartedAt,
              now: now(),
              retryAfterMs: outcome.failure.retryAfterMs,
            },
            retryPolicy,
          )
        : null;
    await dependencies.publications.settleDefinitiveFailure(
      publication.userId,
      publication.id,
      attempt.id,
      attemptRevision(),
      publication.revision,
      'request_sent',
      {
        failureClass: outcome.disposition,
        failureCode: outcome.failure.code,
        failureMessage: null,
        retryable: outcome.disposition === 'retryable' && retryAt !== null,
        ...(retryAt ? { nextAttemptAt: retryAt } : {}),
      },
      lease,
    );
  };

  const runReconciliation = async (
    jobId: string | undefined,
    publication: PublicationRow,
    publisher: PublicationPublisher,
  ) => {
    if (runtimeIsShuttingDown()) return { outcome: 'skipped', reason: 'worker_shutting_down' };
    if (!publisher.reconcile) return { outcome: 'unsupported', reason: 'no_reconciler' };
    const claimed = await dependencies.publications.claimReconciliation(
      publication.userId,
      publication.id,
      publication.revision,
      dependencies.leaseDurationMs,
      now(),
    );
    if (!claimed) return { outcome: 'skipped', reason: 'stale_reconciliation' };
    const heartbeat = startPublicationLeaseHeartbeat({
      intervalMs: dependencies.leaseHeartbeatMs,
      parentSignal: dependencies.shutdownSignal,
      renew: async () =>
        (
          await dependencies.publications.renewPublicationLease(
            claimed.publication.userId,
            claimed.publication.id,
            claimed.publication.revision,
            claimed.publication.leaseToken!,
            dependencies.leaseDurationMs,
            'reconciling',
          )
        ).length > 0,
    });
    let attemptRevision = claimed.attempt.revision;
    const checkpointEvidence = async (input: ProviderEvidence) => {
      if (heartbeat.ownershipLost()) throw new Error('Publication lease was lost');
      const result = await dependencies.publications.checkpointAttemptEvidence(
        claimed.publication.userId,
        claimed.publication.id,
        claimed.attempt.id,
        attemptRevision,
        {
          expectedPublicationRevision: claimed.publication.revision,
          expectedLeaseToken: claimed.publication.leaseToken!,
          expectedPublicationState: 'reconciling',
          expectedAttemptState: 'ambiguous',
        },
        input,
      );
      if (result.outcome !== 'updated' && result.outcome !== 'unchanged')
        throw new Error(`Reconciliation evidence checkpoint was ${result.outcome}`);
      attemptRevision = result.attempt.revision;
    };
    const reconciliationStartedAt =
      claimed.attempt.requestSentAt ??
      claimed.attempt.startedAt ??
      claimed.publication.reconciliationRequiredAt ??
      now();
    const reconciliationMaxAgeReached = () =>
      reconciliationExpired(reconciliationStartedAt, now(), retryPolicy);
    const settleUnresolvedReconciliation = async () => {
      if (reconciliationMaxAgeReached()) {
        await dependencies.publications.markManualReview(
          claimed.publication.userId,
          claimed.publication.id,
          claimed.attempt.id,
          attemptRevision,
          claimed.publication.revision,
          { expectedLeaseToken: claimed.publication.leaseToken! },
        );
        return;
      }
      await dependencies.publications.reconcileUnresolved(
        claimed.publication.userId,
        claimed.publication.id,
        claimed.attempt.id,
        attemptRevision,
        claimed.publication.revision,
        calculateReconciliationAt(now(), retryPolicy),
        { expectedLeaseToken: claimed.publication.leaseToken! },
      );
    };
    try {
      // A shutdown that wins while the claim is in flight must release the newly acquired lease,
      // but must never cross a provider boundary. This settlement is safe because reconciliation
      // itself has not been dispatched.
      if (heartbeat.signal.aborted) {
        if (!heartbeat.ownershipLost()) await settleUnresolvedReconciliation();
        return { outcome: 'skipped', reason: 'worker_shutting_down' };
      }
      if (!dependencies.preflight)
        throw new PublicationPreflightError(
          'terminal',
          'PREFLIGHT_NOT_CONFIGURED',
          'Publication preflight unavailable for reconciliation',
        );
      const prepared = await dependencies.preflight(claimed.publication, heartbeat.signal);
      // The preflight await is a check/use boundary: shutdown may have become authoritative while
      // it was resolving. Do not invoke the provider with a value prepared before that transition.
      if (heartbeat.signal.aborted) {
        if (!heartbeat.ownershipLost()) await settleUnresolvedReconciliation();
        return { outcome: 'skipped', reason: 'worker_shutting_down' };
      }
      const context = contextBase(
        claimed.publication,
        claimed.attempt,
        prepared.credential,
        prepared.media,
        heartbeat.signal,
        evidenceFromAttempt(claimed.attempt),
        checkpointEvidence,
        undefined,
      ) as ReconciliationContext;
      if (heartbeat.signal.aborted) {
        if (!heartbeat.ownershipLost()) await settleUnresolvedReconciliation();
        return { outcome: 'skipped', reason: 'worker_shutting_down' };
      }
      const outcome = await publisher.reconcile(context);
      if (outcome.kind === 'published') {
        await dependencies.publications.reconcileSucceeded(
          claimed.publication.userId,
          claimed.publication.id,
          claimed.attempt.id,
          attemptRevision,
          claimed.publication.revision,
          outcome.remote.remoteOwnerId,
          outcome.remote.remoteMediaId,
          outcome.remote.remoteUrl,
          { expectedLeaseToken: claimed.publication.leaseToken! },
        );
      } else if (outcome.kind === 'definitely_absent') {
        const retryAt =
          outcome.disposition === 'retryable'
            ? calculateRetryAt(
                {
                  attemptId: claimed.attempt.id,
                  attemptCount: claimed.publication.retryCycleAttemptCount,
                  createdAt: claimed.publication.retryCycleStartedAt,
                  now: now(),
                  retryAfterMs: outcome.failure?.retryAfterMs,
                },
                retryPolicy,
              )
            : null;
        if (retryAt) {
          await dependencies.publications.reconcileAbsent(
            claimed.publication.userId,
            claimed.publication.id,
            claimed.attempt.id,
            attemptRevision,
            claimed.publication.revision,
            retryAt,
            { expectedLeaseToken: claimed.publication.leaseToken! },
          );
        } else {
          await dependencies.publications.reconcileTerminalFailure(
            claimed.publication.userId,
            claimed.publication.id,
            claimed.attempt.id,
            attemptRevision,
            claimed.publication.revision,
            outcome.failure?.code ?? 'RECONCILED_ABSENT_EXHAUSTED',
            { expectedLeaseToken: claimed.publication.leaseToken! },
          );
        }
      } else if (outcome.kind === 'manual_review') {
        await dependencies.publications.markManualReview(
          claimed.publication.userId,
          claimed.publication.id,
          claimed.attempt.id,
          attemptRevision,
          claimed.publication.revision,
          { expectedLeaseToken: claimed.publication.leaseToken! },
        );
      } else {
        await settleUnresolvedReconciliation();
      }
      return { outcome: 'processed', jobId };
    } catch (error) {
      if (!heartbeat.ownershipLost()) {
        try {
          await settleUnresolvedReconciliation();
        } catch (settlementError) {
          log('reconciliation_settlement_failed', {
            jobId,
            publicationId: publication.id,
          });
          throw settlementError;
        }
        log('reconciliation_unresolved', { jobId, publicationId: publication.id });
        return { outcome: 'processed', jobId, reason: 'reconciliation_unresolved' };
      }
      throw error;
    } finally {
      await heartbeat.close();
    }
  };

  const processJob = async (job: Job<PublicationJobPayload>) => {
    if (runtimeIsShuttingDown()) return { outcome: 'skipped', reason: 'worker_shutting_down' };
    const parsed = publicationJobPayloadSchema.safeParse(job.data);
    if (!parsed.success) throw new Error('Publication job payload is invalid');
    const payload = parsed.data;
    log('job_received', { jobId: job.id, publicationId: payload.publicationId });
    const rows = await dependencies.publications.findById(payload.publicationId);
    if (runtimeIsShuttingDown()) return { outcome: 'skipped', reason: 'worker_shutting_down' };
    const publication = rows[0];
    if (!publication) return { outcome: 'skipped', reason: 'missing' };
    if (
      publication.revision !== payload.expectedRevision ||
      ['published', 'failed', 'cancelled', 'manual_review'].includes(publication.state)
    )
      return { outcome: 'skipped', reason: 'stale_or_terminal' };
    const publisher = publishers.get(publication.platform);
    const publish = publisher?.publish;
    const legacyExecutor = legacyExecutors.get(publication.platform);
    if (!publish && !legacyExecutor) return { outcome: 'unsupported', reason: 'no_publisher' };
    if (publication.state === 'reconciling')
      return publisher
        ? runReconciliation(job.id, publication, publisher)
        : { outcome: 'unsupported', reason: 'no_reconciler' };
    if (
      publication.state === 'retry_wait' &&
      (!publication.nextAttemptAt || publication.nextAttemptAt.getTime() > now().getTime())
    )
      return { outcome: 'skipped', reason: 'not_due' };
    if (publication.state !== 'queued' && publication.state !== 'retry_wait')
      return { outcome: 'skipped', reason: 'already_owned' };

    if (runtimeIsShuttingDown()) return { outcome: 'skipped', reason: 'worker_shutting_down' };
    const claimed = await dependencies.publications.claimPublication(
      publication.userId,
      publication.id,
      publication.state,
      publication.revision,
      dependencies.leaseDurationMs,
    );
    const heartbeat = startPublicationLeaseHeartbeat({
      intervalMs: dependencies.leaseHeartbeatMs,
      parentSignal: dependencies.shutdownSignal,
      renew: async () =>
        (
          await dependencies.publications.renewPublicationLease(
            claimed.publication.userId,
            claimed.publication.id,
            claimed.publication.revision,
            claimed.publication.leaseToken!,
            dependencies.leaseDurationMs,
            'publishing',
          )
        ).length > 0,
    });
    try {
      const settleStartedShutdown = async () => {
        if (!heartbeat.ownershipLost())
          await settlePreflightFailure(
            claimed.publication,
            claimed.attempt,
            { expectedLeaseToken: claimed.publication.leaseToken! },
            new PublicationPreflightError(
              'retryable',
              'WORKER_SHUTDOWN_BEFORE_PROVIDER_DISPATCH',
              'Worker shutdown prevented provider dispatch',
            ),
          );
      };
      if (heartbeat.signal.aborted) {
        await settleStartedShutdown();
        return { outcome: 'skipped', reason: 'worker_shutting_down' };
      }
      const legacyOwnership = dependencies.legacyCredentialOwnership?.(claimed.publication);
      const prepared = dependencies.preflight
        ? await dependencies.preflight(claimed.publication, heartbeat.signal)
        : legacyExecutor && legacyOwnership
          ? {
              credential: {
                ...legacyOwnership,
                accessToken: 'legacy-test-token',
                providerAccountId: '',
                scopes: [],
                getAccessToken: async () => 'legacy-test-token',
              },
              media: {
                sizeBytes: 1,
                contentType: 'application/octet-stream',
                openReadStream: async () => {
                  throw new Error('Legacy executor does not consume media');
                },
              },
            }
          : undefined;
      if (heartbeat.signal.aborted) {
        await settleStartedShutdown();
        return { outcome: 'skipped', reason: 'worker_shutting_down' };
      }
      if (!prepared) {
        await settlePreflightFailure(
          claimed.publication,
          claimed.attempt,
          { expectedLeaseToken: claimed.publication.leaseToken! },
          new PublicationPreflightError(
            'terminal',
            'PREFLIGHT_NOT_CONFIGURED',
            'Publication preflight unavailable',
          ),
        );
        return { outcome: 'preflight_failed' };
      }
      if (!legacyExecutor && !isCredentialSnapshot(prepared.credential)) {
        await settlePreflightFailure(
          claimed.publication,
          claimed.attempt,
          { expectedLeaseToken: claimed.publication.leaseToken! },
          new PublicationPreflightError(
            'terminal',
            'PREFLIGHT_CREDENTIAL_SNAPSHOT_INVALID',
            'Credential preflight did not return a generation-bound snapshot',
          ),
        );
        return { outcome: 'preflight_failed' };
      }
      if (heartbeat.signal.aborted) {
        await settleStartedShutdown();
        return { outcome: 'skipped', reason: 'worker_shutting_down' };
      }
      if (publisher?.capabilityPreflight) {
        if (heartbeat.signal.aborted) {
          await settleStartedShutdown();
          return { outcome: 'skipped', reason: 'worker_shutting_down' };
        }
        let capability;
        try {
          capability = await publisher.capabilityPreflight({
            publicationId: claimed.publication.id,
            platform: claimed.publication.platform as 'youtube' | 'vk',
            credential: prepared.credential,
            signal: heartbeat.signal,
          });
        } catch {
          throw new PublicationPreflightError(
            'retryable',
            'PROVIDER_CAPABILITY_PREFLIGHT_FAILED',
            'Provider capability preflight failed before request intent',
          );
        }
        if (capability.kind === 'failure') {
          const disposition =
            capability.failure.classification === 'reauthorization_required'
              ? 'reauthorization_required'
              : capability.failure.classification === 'definite_retryable'
                ? 'retryable'
                : 'terminal';
          throw new PublicationPreflightError(
            disposition,
            capability.failure.code,
            'Provider capability preflight rejected publication',
          );
        }
        if (heartbeat.signal.aborted) {
          await settleStartedShutdown();
          return { outcome: 'skipped', reason: 'worker_shutting_down' };
        }
      }
      if (heartbeat.signal.aborted) {
        await settleStartedShutdown();
        return { outcome: 'skipped', reason: 'worker_shutting_down' };
      }
      const [requestSent] = await dependencies.publications.markAttemptRequestSent(
        claimed.publication.userId,
        claimed.attempt.id,
        claimed.attempt.revision,
        {
          publicationId: claimed.publication.id,
          expectedPublicationRevision: claimed.publication.revision,
          expectedLeaseToken: claimed.publication.leaseToken!,
          credential: {
            accountId: prepared.credential.accountId,
            userId: prepared.credential.userId,
            platform: prepared.credential.platform,
            credentialRevision: prepared.credential.credentialRevision,
          },
        },
      );
      if (!requestSent) return { outcome: 'skipped', reason: 'request_intent_stale' };
      let attemptRevision = requestSent.revision;
      const checkpointEvidence = async (input: ProviderEvidence) => {
        if (heartbeat.ownershipLost()) throw new Error('Publication lease was lost');
        const evidence = await dependencies.publications.checkpointAttemptEvidence(
          claimed.publication.userId,
          claimed.publication.id,
          claimed.attempt.id,
          attemptRevision,
          {
            expectedPublicationRevision: claimed.publication.revision,
            expectedLeaseToken: claimed.publication.leaseToken!,
            expectedPublicationState: 'publishing',
            expectedAttemptState: 'request_sent',
          },
          input,
        );
        if (evidence.outcome !== 'updated' && evidence.outcome !== 'unchanged')
          throw new Error(`Publication evidence checkpoint was ${evidence.outcome}`);
        attemptRevision = evidence.attempt.revision;
      };
      // Request intent may have committed concurrently with shutdown. Since provider dispatch has
      // not happened, settle a definitive retryable failure rather than creating ambiguity or
      // invoking a provider after the monotonic gate closed.
      if (heartbeat.signal.aborted) {
        if (!heartbeat.ownershipLost())
          await settlePublishOutcome(
            claimed.publication,
            requestSent,
            () => attemptRevision,
            { expectedLeaseToken: claimed.publication.leaseToken! },
            {
              kind: 'definite_failure',
              disposition: 'retryable',
              failure: {
                classification: 'definite_retryable',
                code: 'WORKER_SHUTDOWN_BEFORE_PROVIDER_DISPATCH',
              },
            },
          );
        return { outcome: 'skipped', reason: 'worker_shutting_down' };
      }
      const context: PublicationContext = contextBase(
        claimed.publication,
        requestSent,
        prepared.credential,
        prepared.media,
        heartbeat.signal,
        evidenceFromAttempt(requestSent),
        checkpointEvidence,
        (progress) =>
          log('publication_progress', {
            publicationId: claimed.publication.id,
            attemptId: claimed.attempt.id,
            uploadedBytes: progress.uploadedBytes,
            totalBytes: progress.totalBytes,
          }),
      ) as PublicationContext;
      if (heartbeat.signal.aborted) {
        if (!heartbeat.ownershipLost())
          await settlePublishOutcome(
            claimed.publication,
            requestSent,
            () => attemptRevision,
            { expectedLeaseToken: claimed.publication.leaseToken! },
            {
              kind: 'definite_failure',
              disposition: 'retryable',
              failure: {
                classification: 'definite_retryable',
                code: 'WORKER_SHUTDOWN_BEFORE_PROVIDER_DISPATCH',
              },
            },
          );
        return { outcome: 'skipped', reason: 'worker_shutting_down' };
      }
      if (legacyExecutor) {
        try {
          await legacyExecutor.executeAfterRequestSent({
            ...context,
            attempt: requestSent,
            settleSuccess: async (remoteOwnerId, remoteMediaId, remoteUrl) => {
              await settlePublishOutcome(
                claimed.publication,
                requestSent,
                () => attemptRevision,
                { expectedLeaseToken: claimed.publication.leaseToken! },
                {
                  kind: 'published',
                  remote: { remoteOwnerId, remoteMediaId, remoteUrl },
                },
              );
            },
            markAmbiguous: async () => {
              await dependencies.publications.markAmbiguous(
                claimed.publication.userId,
                claimed.publication.id,
                claimed.attempt.id,
                attemptRevision,
                claimed.publication.revision,
                { expectedLeaseToken: claimed.publication.leaseToken! },
              );
            },
          });
        } catch (error) {
          if (!heartbeat.ownershipLost()) {
            await dependencies.publications
              .markAmbiguous(
                claimed.publication.userId,
                claimed.publication.id,
                claimed.attempt.id,
                attemptRevision,
                claimed.publication.revision,
                { expectedLeaseToken: claimed.publication.leaseToken! },
              )
              .catch(() => undefined);
          }
          throw error;
        }
        return { outcome: 'processed' };
      }
      let outcome: PublishOutcome;
      try {
        outcome = await publish!(context);
        if (heartbeat.signal.aborted) throw new Error('Publication operation was aborted');
      } catch (error) {
        if (!heartbeat.ownershipLost()) {
          await dependencies.publications
            .markAmbiguous(
              claimed.publication.userId,
              claimed.publication.id,
              claimed.attempt.id,
              attemptRevision,
              claimed.publication.revision,
              { expectedLeaseToken: claimed.publication.leaseToken! },
            )
            .catch(() => undefined);
        }
        log('job_ambiguous', {
          jobId: job.id,
          publicationId: publication.id,
          reason: 'publisher_exception',
        });
        throw error;
      }
      const normalizedOutcome = normalizePublishOutcome(outcome);
      if (normalizedOutcome.kind === 'ambiguous' && normalizedOutcome.evidence)
        await checkpointEvidence(normalizedOutcome.evidence);
      await settlePublishOutcome(
        claimed.publication,
        requestSent,
        () => attemptRevision,
        { expectedLeaseToken: claimed.publication.leaseToken! },
        normalizedOutcome,
      );
      return { outcome: 'processed' };
    } catch (error) {
      if (error instanceof PublicationPreflightError) {
        if (!heartbeat.ownershipLost())
          await settlePreflightFailure(
            claimed.publication,
            claimed.attempt,
            { expectedLeaseToken: claimed.publication.leaseToken! },
            error,
          );
        return { outcome: 'preflight_failed' };
      }
      throw error;
    } finally {
      await heartbeat.close();
    }
  };

  const active = new Set<Promise<unknown>>();
  const processor = ((job: Job<PublicationJobPayload>) => {
    let tracked!: Promise<unknown>;
    tracked = processJob(job).finally(() => active.delete(tracked));
    active.add(tracked);
    return tracked;
  }) as PublicationJobProcessor;
  processor.waitForIdle = async () => {
    // A settlement can synchronously allow another already-dispatched handler to enter. Looping
    // makes the quiescence boundary stable rather than relying on one Set snapshot.
    while (active.size > 0) await Promise.allSettled([...active]);
  };
  return processor;
}
