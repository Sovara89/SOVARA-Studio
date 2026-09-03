import { describe, expect, test, vi } from 'vitest';
import { createYouTubePublisher } from '@sovara-studio/platforms';
import { createPublicationJobProcessor } from './publication-job-processor.js';

const publication = {
  id: '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
  userId: '8f6a7c3b-8e7b-4f54-9e4a-1b2c3d4e5f60',
  revision: 0,
  state: 'queued' as const,
  platform: 'youtube' as const,
  nextAttemptAt: null,
};

function job() {
  return {
    id: 'publication-4c4f8e30-e24e-4cde-9534-a43f4b3f98e8-r0',
    data: { publicationId: publication.id, expectedRevision: 0 },
  } as never;
}

describe('publication job processor', () => {
  const credential = {
    accountId: 'account-1',
    userId: publication.userId,
    platform: 'youtube' as const,
    credentialRevision: 1,
    accessToken: 'access-token',
    providerAccountId: 'channel-1',
    scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
  };
  const media = { sizeBytes: 10, contentType: 'video/mp4', openReadStream: vi.fn() };

  test('does not claim a publication without a registered publisher', async () => {
    const claimPublication = vi.fn();
    const publications = {
      findById: vi.fn().mockResolvedValue([publication]),
      claimPublication,
    } as never;

    const result = await createPublicationJobProcessor({
      publications,
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
    })(job());

    expect(result).toEqual({ outcome: 'unsupported', reason: 'no_publisher' });
    expect(claimPublication).not.toHaveBeenCalled();
  });

  test('does not claim a stale revision during redelivery', async () => {
    const claimPublication = vi.fn();
    const publications = {
      findById: vi.fn().mockResolvedValue([{ ...publication, revision: 1 }]),
      claimPublication,
    } as never;

    const result = await createPublicationJobProcessor({
      publications,
      executors: new Map([['youtube', { executeAfterRequestSent: vi.fn() }]]),
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
    })(job());

    expect(result).toEqual({ outcome: 'skipped', reason: 'stale_or_terminal' });
    expect(claimPublication).not.toHaveBeenCalled();
  });

  test('claims, records request intent, and settles through the repository', async () => {
    const events: string[] = [];
    const markAttemptRequestSent = vi.fn().mockImplementation(async () => {
      events.push('request_sent');
      return [{ id: 'attempt-1', revision: 1, state: 'request_sent' }];
    });
    const settleDefinitiveSuccess = vi.fn().mockResolvedValue(undefined);
    const claimed = {
      publication: {
        ...publication,
        state: 'publishing' as const,
        revision: 1,
        leaseToken: 'lease-token',
        userId: publication.userId,
      },
      attempt: { id: 'attempt-1', revision: 0, state: 'started' as const },
    };
    const publications = {
      findById: vi.fn().mockResolvedValue([publication]),
      claimPublication: vi.fn().mockResolvedValue(claimed),
      renewPublicationLease: vi.fn().mockResolvedValue([claimed.publication]),
      markAttemptRequestSent,
      markAmbiguous: vi.fn().mockResolvedValue(undefined),
      settleDefinitiveSuccess,
    } as never;
    const executeAfterRequestSent = vi.fn(async (context) => {
      events.push(`executor:${context.attempt.state}`);
      await context.settleSuccess(null, 'remote-media-1');
    });

    const result = await createPublicationJobProcessor({
      publications,
      executors: new Map([['youtube', { executeAfterRequestSent }]]),
      legacyCredentialOwnership: () => ({
        accountId: 'account-1',
        userId: publication.userId,
        platform: 'youtube',
        credentialRevision: 0,
      }),
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
    })(job());

    expect(result).toEqual({ outcome: 'processed' });
    expect(executeAfterRequestSent).toHaveBeenCalledOnce();
    expect(events).toEqual(['request_sent', 'executor:request_sent']);
    expect(settleDefinitiveSuccess).toHaveBeenCalledWith(
      publication.userId,
      publication.id,
      'attempt-1',
      1,
      1,
      null,
      'remote-media-1',
      undefined,
      { expectedLeaseToken: 'lease-token' },
    );
  });

  test('does not invoke the executor when request intent persistence fails', async () => {
    const executeAfterRequestSent = vi.fn();
    const publications = {
      findById: vi.fn().mockResolvedValue([publication]),
      claimPublication: vi.fn().mockResolvedValue({
        publication: {
          ...publication,
          state: 'publishing',
          revision: 1,
          leaseToken: 'lease-token',
        },
        attempt: { id: 'attempt-1', revision: 0, state: 'started' },
      }),
      markAttemptRequestSent: vi.fn().mockResolvedValue([]),
    } as never;

    await expect(
      createPublicationJobProcessor({
        publications,
        executors: new Map([['youtube', { executeAfterRequestSent }]]),
        legacyCredentialOwnership: () => ({
          accountId: 'account-1',
          userId: publication.userId,
          platform: 'youtube',
          credentialRevision: 0,
        }),
        leaseDurationMs: 1_000,
        leaseHeartbeatMs: 100,
      })(job()),
    ).resolves.toEqual({ outcome: 'skipped', reason: 'request_intent_stale' });
    expect(executeAfterRequestSent).not.toHaveBeenCalled();
  });

  test('moves an executor failure toward reconciliation after request intent', async () => {
    const markAmbiguous = vi.fn().mockResolvedValue(undefined);
    const publications = {
      findById: vi.fn().mockResolvedValue([publication]),
      claimPublication: vi.fn().mockResolvedValue({
        publication: {
          ...publication,
          state: 'publishing',
          revision: 1,
          leaseToken: 'lease-token',
        },
        attempt: { id: 'attempt-1', revision: 0, state: 'started' },
      }),
      markAttemptRequestSent: vi
        .fn()
        .mockResolvedValue([{ id: 'attempt-1', revision: 1, state: 'request_sent' }]),
      markAmbiguous,
    } as never;
    const executeAfterRequestSent = vi.fn().mockRejectedValue(new Error('provider timeout'));

    await expect(
      createPublicationJobProcessor({
        publications,
        executors: new Map([['youtube', { executeAfterRequestSent }]]),
        legacyCredentialOwnership: () => ({
          accountId: 'account-1',
          userId: publication.userId,
          platform: 'youtube',
          credentialRevision: 0,
        }),
        leaseDurationMs: 1_000,
        leaseHeartbeatMs: 100,
      })(job()),
    ).rejects.toThrow('provider timeout');
    expect(markAmbiguous).toHaveBeenCalledOnce();
  });

  test('preflights before request intent and invokes the generic publisher afterward', async () => {
    const events: string[] = [];
    const claimed = {
      publication: {
        ...publication,
        state: 'publishing' as const,
        revision: 1,
        leaseToken: 'lease-token',
      },
      attempt: { id: 'attempt-1', revision: 0, state: 'started' as const },
    };
    const markAttemptRequestSent = vi.fn().mockImplementation(async () => {
      events.push('request_sent');
      return [{ id: 'attempt-1', revision: 1, state: 'request_sent' as const }];
    });
    const settleDefinitiveSuccess = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn(async (context) => {
      events.push(`publish:${context.attemptId}`);
      return {
        kind: 'published' as const,
        remote: { remoteMediaId: 'remote-media-1' },
      };
    });
    const capabilityPreflight = vi.fn(async () => {
      events.push('capability');
      return { kind: 'ready' as const };
    });
    const publications = {
      findById: vi.fn().mockResolvedValue([publication]),
      claimPublication: vi.fn().mockImplementation(async () => {
        events.push('claim');
        return claimed;
      }),
      renewPublicationLease: vi.fn().mockResolvedValue([claimed.publication]),
      markAttemptRequestSent,
      settleDefinitiveSuccess,
    } as never;
    const preflight = vi.fn().mockImplementation(async () => {
      events.push('preflight');
      return {
        credential: {
          accountId: 'account-1',
          userId: publication.userId,
          platform: 'youtube',
          credentialRevision: 1,
          accessToken: 'access-token',
          providerAccountId: 'channel-1',
          scopes: ['https://www.googleapis.com/auth/youtube.upload'],
          getAccessToken: vi.fn().mockResolvedValue('access-token'),
        },
        media: {
          sizeBytes: 10,
          contentType: 'video/mp4',
          openReadStream: vi.fn(),
        },
      };
    });

    const result = await createPublicationJobProcessor({
      publications,
      publishers: new Map([
        ['youtube', { platform: 'youtube', capabilityPreflight, publish, reconcile: vi.fn() }],
      ]),
      preflight,
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
    })(job());

    expect(result).toEqual({ outcome: 'processed' });
    expect(events).toEqual([
      'claim',
      'preflight',
      'capability',
      'request_sent',
      'publish:attempt-1',
    ]);
    expect(settleDefinitiveSuccess).toHaveBeenCalledWith(
      publication.userId,
      publication.id,
      'attempt-1',
      1,
      1,
      undefined,
      'remote-media-1',
      undefined,
      { expectedLeaseToken: 'lease-token' },
    );
  });

  test('settles a failed provider capability check while attempt is started and never records request intent', async () => {
    const claimed = {
      publication: {
        ...publication,
        state: 'publishing' as const,
        revision: 1,
        leaseToken: 'lease-token',
      },
      attempt: { id: 'attempt-1', revision: 0, state: 'started' as const },
    };
    const markAttemptRequestSent = vi.fn();
    const settleDefinitiveFailure = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn();
    const preflight = vi.fn().mockResolvedValue({
      credential: {
        accountId: 'account-1',
        userId: publication.userId,
        platform: 'vk',
        credentialRevision: 1,
        accessToken: 'token',
        providerAccountId: '12345',
        scopes: ['video'],
        getAccessToken: vi.fn().mockResolvedValue('token'),
      },
      media: { sizeBytes: 10, contentType: 'video/mp4', openReadStream: vi.fn() },
    });
    const capabilityPreflight = vi.fn().mockResolvedValue({
      kind: 'failure',
      failure: {
        classification: 'definite_terminal',
        code: 'VK_GROUP_CAPABILITY_DENIED',
      },
    });
    const publications = {
      findById: vi.fn().mockResolvedValue([{ ...publication, platform: 'vk' }]),
      claimPublication: vi.fn().mockResolvedValue(claimed),
      renewPublicationLease: vi.fn().mockResolvedValue([claimed.publication]),
      markAttemptRequestSent,
      settleDefinitiveFailure,
    } as never;

    const result = await createPublicationJobProcessor({
      publications,
      publishers: new Map([
        ['vk', { platform: 'vk', capabilityPreflight, publish, reconcile: vi.fn() }],
      ]),
      preflight,
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
    })(job());

    expect(result).toEqual({ outcome: 'preflight_failed' });
    expect(capabilityPreflight).toHaveBeenCalledOnce();
    expect(markAttemptRequestSent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(settleDefinitiveFailure).toHaveBeenCalledWith(
      publication.userId,
      publication.id,
      'attempt-1',
      0,
      1,
      'started',
      expect.objectContaining({
        failureClass: 'preflight',
        failureCode: 'VK_GROUP_CAPABILITY_DENIED',
        retryable: false,
      }),
      { expectedLeaseToken: 'lease-token' },
    );
  });

  test('keeps no-ID reconciliation on the same attempt and redelivery cannot initiate upload', async () => {
    const providerRequest = vi.fn();
    const publisher = createYouTubePublisher({ fetch: providerRequest });
    const reconciling = {
      ...publication,
      revision: 3,
      state: 'reconciling' as const,
      reconciliationRequiredAt: new Date(1_000),
      attemptCount: 1,
      createdAt: new Date(0),
    };
    const claimed = {
      publication: {
        ...reconciling,
        revision: 4,
        leaseToken: 'reconciliation-lease',
      },
      attempt: {
        id: 'attempt-1',
        revision: 2,
        state: 'ambiguous' as const,
        requestSentAt: new Date(500),
        startedAt: new Date(400),
        providerRequestId: null,
        remoteOwnerId: null,
        remoteMediaId: null,
        remoteUrl: null,
      },
    };
    const reconcileUnresolved = vi.fn().mockResolvedValue(undefined);
    const claimPublication = vi.fn();
    const publications = {
      findById: vi
        .fn()
        .mockResolvedValueOnce([reconciling])
        .mockResolvedValueOnce([{ ...reconciling, revision: 5 }]),
      claimPublication,
      claimReconciliation: vi.fn().mockResolvedValue(claimed),
      renewPublicationLease: vi.fn().mockResolvedValue([claimed.publication]),
      reconcileUnresolved,
      markManualReview: vi.fn(),
    } as never;
    const preflight = vi.fn().mockResolvedValue({
      credential: {
        accountId: 'account-1',
        userId: publication.userId,
        platform: 'youtube',
        credentialRevision: 1,
        accessToken: 'token',
        providerAccountId: 'channel-1',
        scopes: ['https://www.googleapis.com/auth/youtube.upload'],
        getAccessToken: vi.fn().mockResolvedValue('token'),
      },
      media: { sizeBytes: 1, contentType: 'video/mp4', openReadStream: vi.fn() },
    });
    const processor = createPublicationJobProcessor({
      publications,
      publishers: new Map([['youtube', publisher]]),
      preflight,
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
      now: () => new Date(2_000),
    });
    const reconciliationJob = {
      id: 'reconcile-job',
      data: { publicationId: publication.id, expectedRevision: 3 },
    } as never;

    await expect(processor(reconciliationJob)).resolves.toMatchObject({ outcome: 'processed' });
    await expect(processor(reconciliationJob)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'stale_or_terminal',
    });
    expect(reconcileUnresolved).toHaveBeenCalledOnce();
    expect(claimPublication).not.toHaveBeenCalled();
    expect(providerRequest).not.toHaveBeenCalled();
  });

  test('bounds reconciliation credential failures by max age and settles manual review', async () => {
    const reconciling = {
      ...publication,
      revision: 3,
      state: 'reconciling' as const,
      reconciliationRequiredAt: new Date(9_000),
      attemptCount: 1,
      createdAt: new Date(0),
    };
    const claimed = {
      publication: { ...reconciling, revision: 4, leaseToken: 'reconciliation-lease' },
      attempt: {
        id: 'attempt-1',
        revision: 2,
        state: 'ambiguous' as const,
        requestSentAt: new Date(1_000),
        startedAt: new Date(900),
      },
    };
    const markManualReview = vi.fn().mockResolvedValue(undefined);
    const reconcileUnresolved = vi.fn();
    const publications = {
      findById: vi.fn().mockResolvedValue([reconciling]),
      claimReconciliation: vi.fn().mockResolvedValue(claimed),
      renewPublicationLease: vi.fn().mockResolvedValue([claimed.publication]),
      markManualReview,
      reconcileUnresolved,
    } as never;
    const publisher = {
      platform: 'youtube' as const,
      publish: vi.fn(),
      reconcile: vi.fn(),
    };
    const retryPolicy = {
      maxProviderAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxRetryWindowMs: 100_000,
      reconciliationDelayMs: 500,
      reconciliationMaxAgeMs: 5_000,
      maxProviderRetryAfterMs: 1_000,
    };
    const processor = createPublicationJobProcessor({
      publications,
      publishers: new Map([['youtube', publisher]]),
      preflight: vi.fn().mockRejectedValue(new Error('credential unavailable')),
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
      retryPolicy,
      now: () => new Date(10_000),
    });

    await expect(
      processor({
        id: 'reconcile-credential-job',
        data: { publicationId: publication.id, expectedRevision: 3 },
      } as never),
    ).resolves.toMatchObject({
      outcome: 'processed',
      reason: 'reconciliation_unresolved',
    });
    expect(markManualReview).toHaveBeenCalledOnce();
    expect(reconcileUnresolved).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(publisher.reconcile).not.toHaveBeenCalled();
  });

  test('propagates runtime shutdown into an active handler and reports idle only after teardown', async () => {
    const shutdown = new AbortController();
    const claimed = {
      publication: {
        ...publication,
        state: 'publishing' as const,
        revision: 1,
        leaseToken: 'lease-token',
      },
      attempt: { id: 'attempt-1', revision: 0, state: 'started' as const },
    };
    const markAmbiguous = vi.fn().mockResolvedValue(undefined);
    const publications = {
      findById: vi.fn().mockResolvedValue([publication]),
      claimPublication: vi.fn().mockResolvedValue(claimed),
      renewPublicationLease: vi.fn().mockResolvedValue([claimed.publication]),
      markAttemptRequestSent: vi
        .fn()
        .mockResolvedValue([{ id: 'attempt-1', revision: 1, state: 'request_sent' }]),
      markAmbiguous,
    } as never;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let finishProviderTeardown!: () => void;
    let providerSignal: AbortSignal | undefined;
    const executeAfterRequestSent = vi.fn(
      (context) =>
        new Promise<void>((_resolve, reject) => {
          providerSignal = context.signal;
          resolveStarted();
          context.signal.addEventListener(
            'abort',
            () => {
              finishProviderTeardown = () => reject(new Error('provider teardown completed'));
            },
            { once: true },
          );
        }),
    );
    const processor = createPublicationJobProcessor({
      publications,
      executors: new Map([['youtube', { executeAfterRequestSent }]]),
      legacyCredentialOwnership: () => ({
        accountId: 'account-1',
        userId: publication.userId,
        platform: 'youtube',
        credentialRevision: 0,
      }),
      shutdownSignal: shutdown.signal,
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
    });
    const jobSettlement = processor(job()).then(
      (value) => value,
      (error: unknown) => error,
    );

    await started;
    let idleSettled = false;
    const idle = processor.waitForIdle().then(() => {
      idleSettled = true;
    });
    shutdown.abort(new Error('runtime shutdown'));
    expect(providerSignal?.aborted).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(idleSettled).toBe(false);

    finishProviderTeardown();
    await expect(jobSettlement).resolves.toMatchObject({ message: 'provider teardown completed' });
    await idle;
    expect(idleSettled).toBe(true);
    expect(markAmbiguous).toHaveBeenCalledOnce();
  });

  test('does not claim after shutdown wins while the publication read is in flight', async () => {
    const shutdown = new AbortController();
    let resolveRead!: (rows: (typeof publication)[]) => void;
    const findById = vi.fn(
      () =>
        new Promise<(typeof publication)[]>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const claimPublication = vi.fn();
    const processor = createPublicationJobProcessor({
      publications: { findById, claimPublication } as never,
      publishers: new Map([['youtube', { platform: 'youtube', publish: vi.fn() }]]),
      shutdownSignal: shutdown.signal,
      preflight: vi.fn(),
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
    });
    const processing = processor(job());

    await vi.waitFor(() => expect(findById).toHaveBeenCalledOnce());
    shutdown.abort(new Error('shutdown'));
    resolveRead([publication]);

    await expect(processing).resolves.toEqual({
      outcome: 'skipped',
      reason: 'worker_shutting_down',
    });
    expect(claimPublication).not.toHaveBeenCalled();
  });

  test('settles a claim safely when shutdown wins during claim and never starts preflight', async () => {
    const shutdown = new AbortController();
    const claimed = {
      publication: {
        ...publication,
        state: 'publishing' as const,
        revision: 1,
        leaseToken: 'lease-token',
        attemptCount: 1,
        createdAt: new Date(0),
      },
      attempt: { id: 'attempt-1', revision: 0, state: 'started' as const },
    };
    let resolveClaim!: (value: typeof claimed) => void;
    const claimPublication = vi.fn(
      () =>
        new Promise<typeof claimed>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const settleDefinitiveFailure = vi.fn().mockResolvedValue(undefined);
    const preflight = vi.fn();
    const publish = vi.fn();
    const processor = createPublicationJobProcessor({
      publications: {
        findById: vi.fn().mockResolvedValue([publication]),
        claimPublication,
        settleDefinitiveFailure,
      } as never,
      publishers: new Map([['youtube', { platform: 'youtube', publish }]]),
      shutdownSignal: shutdown.signal,
      preflight,
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
      now: () => new Date(1_000),
    });
    const processing = processor(job());

    await vi.waitFor(() => expect(claimPublication).toHaveBeenCalledOnce());
    shutdown.abort(new Error('shutdown'));
    resolveClaim(claimed);

    await expect(processing).resolves.toEqual({
      outcome: 'skipped',
      reason: 'worker_shutting_down',
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(settleDefinitiveFailure).toHaveBeenCalledWith(
      publication.userId,
      publication.id,
      'attempt-1',
      0,
      1,
      'started',
      expect.objectContaining({
        failureCode: 'WORKER_SHUTDOWN_BEFORE_PROVIDER_DISPATCH',
        retryable: true,
      }),
      { expectedLeaseToken: 'lease-token' },
    );
  });

  test('closes the post-capability check/use race without recording request intent', async () => {
    const shutdown = new AbortController();
    const claimed = {
      publication: {
        ...publication,
        state: 'publishing' as const,
        revision: 1,
        leaseToken: 'lease-token',
        attemptCount: 1,
        createdAt: new Date(0),
      },
      attempt: { id: 'attempt-1', revision: 0, state: 'started' as const },
    };
    let resolveCapability!: (value: { kind: 'ready' }) => void;
    const capabilityPreflight = vi.fn(
      () =>
        new Promise<{ kind: 'ready' }>((resolve) => {
          resolveCapability = resolve;
        }),
    );
    const markAttemptRequestSent = vi.fn();
    const settleDefinitiveFailure = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn();
    const processor = createPublicationJobProcessor({
      publications: {
        findById: vi.fn().mockResolvedValue([publication]),
        claimPublication: vi.fn().mockResolvedValue(claimed),
        renewPublicationLease: vi.fn().mockResolvedValue([claimed.publication]),
        markAttemptRequestSent,
        settleDefinitiveFailure,
      } as never,
      publishers: new Map([['youtube', { platform: 'youtube', capabilityPreflight, publish }]]),
      shutdownSignal: shutdown.signal,
      preflight: vi.fn().mockResolvedValue({ credential, media }),
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
      now: () => new Date(1_000),
    });
    const processing = processor(job());

    await vi.waitFor(() => expect(capabilityPreflight).toHaveBeenCalledOnce());
    shutdown.abort(new Error('shutdown'));
    resolveCapability({ kind: 'ready' });

    await expect(processing).resolves.toEqual({
      outcome: 'skipped',
      reason: 'worker_shutting_down',
    });
    expect(markAttemptRequestSent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(settleDefinitiveFailure).toHaveBeenCalledOnce();
  });

  test('definitively settles committed intent when shutdown wins its await and never dispatches', async () => {
    const shutdown = new AbortController();
    const claimed = {
      publication: {
        ...publication,
        state: 'publishing' as const,
        revision: 1,
        leaseToken: 'lease-token',
        attemptCount: 1,
        createdAt: new Date(0),
      },
      attempt: { id: 'attempt-1', revision: 0, state: 'started' as const },
    };
    const requestSent = { id: 'attempt-1', revision: 1, state: 'request_sent' as const };
    let resolveIntent!: (rows: (typeof requestSent)[]) => void;
    const markAttemptRequestSent = vi.fn(
      () =>
        new Promise<(typeof requestSent)[]>((resolve) => {
          resolveIntent = resolve;
        }),
    );
    const settleDefinitiveFailure = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn();
    const processor = createPublicationJobProcessor({
      publications: {
        findById: vi.fn().mockResolvedValue([publication]),
        claimPublication: vi.fn().mockResolvedValue(claimed),
        renewPublicationLease: vi.fn().mockResolvedValue([claimed.publication]),
        markAttemptRequestSent,
        settleDefinitiveFailure,
      } as never,
      publishers: new Map([['youtube', { platform: 'youtube', publish }]]),
      shutdownSignal: shutdown.signal,
      preflight: vi.fn().mockResolvedValue({ credential, media }),
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
      now: () => new Date(1_000),
    });
    const processing = processor(job());

    await vi.waitFor(() => expect(markAttemptRequestSent).toHaveBeenCalledOnce());
    shutdown.abort(new Error('shutdown'));
    resolveIntent([requestSent]);

    await expect(processing).resolves.toEqual({
      outcome: 'skipped',
      reason: 'worker_shutting_down',
    });
    expect(publish).not.toHaveBeenCalled();
    expect(settleDefinitiveFailure).toHaveBeenCalledWith(
      publication.userId,
      publication.id,
      'attempt-1',
      1,
      1,
      'request_sent',
      expect.objectContaining({
        failureCode: 'WORKER_SHUTDOWN_BEFORE_PROVIDER_DISPATCH',
        retryable: true,
      }),
      { expectedLeaseToken: 'lease-token' },
    );
  });

  test('does not dispatch reconciliation after shutdown wins the preflight await', async () => {
    const shutdown = new AbortController();
    const reconciling = {
      ...publication,
      revision: 3,
      state: 'reconciling' as const,
      reconciliationRequiredAt: new Date(500),
      attemptCount: 1,
      createdAt: new Date(0),
    };
    const claimed = {
      publication: { ...reconciling, revision: 4, leaseToken: 'reconciliation-lease' },
      attempt: {
        id: 'attempt-1',
        revision: 2,
        state: 'ambiguous' as const,
        requestSentAt: new Date(500),
        startedAt: new Date(400),
      },
    };
    let resolvePreflight!: (value: { credential: typeof credential; media: typeof media }) => void;
    const preflight = vi.fn(
      () =>
        new Promise<{ credential: typeof credential; media: typeof media }>((resolve) => {
          resolvePreflight = resolve;
        }),
    );
    const reconcile = vi.fn();
    const reconcileUnresolved = vi.fn().mockResolvedValue(undefined);
    const processor = createPublicationJobProcessor({
      publications: {
        findById: vi.fn().mockResolvedValue([reconciling]),
        claimReconciliation: vi.fn().mockResolvedValue(claimed),
        renewPublicationLease: vi.fn().mockResolvedValue([claimed.publication]),
        reconcileUnresolved,
        markManualReview: vi.fn(),
      } as never,
      publishers: new Map([['youtube', { platform: 'youtube', publish: vi.fn(), reconcile }]]),
      shutdownSignal: shutdown.signal,
      preflight,
      leaseDurationMs: 1_000,
      leaseHeartbeatMs: 100,
      now: () => new Date(1_000),
    });
    const processing = processor({
      id: 'reconciliation-race',
      data: { publicationId: publication.id, expectedRevision: 3 },
    } as never);

    await vi.waitFor(() => expect(preflight).toHaveBeenCalledOnce());
    shutdown.abort(new Error('shutdown'));
    resolvePreflight({ credential, media });

    await expect(processing).resolves.toEqual({
      outcome: 'skipped',
      reason: 'worker_shutting_down',
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(reconcileUnresolved).toHaveBeenCalledOnce();
  });
});
