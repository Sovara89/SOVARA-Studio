import type { Readable } from 'node:stream';

export type PublicationPlatform = 'youtube' | 'vk';

export type DefiniteProviderFailure = {
  classification: 'definite_retryable' | 'definite_terminal' | 'reauthorization_required';
  code: string;
  status?: number;
  message?: string;
  retryAfterMs?: number;
};

export type AmbiguousProviderFailure = {
  classification: 'ambiguous';
  code: string;
  status?: number;
  message?: string;
  retryAfterMs?: number;
};

export type SafeProviderFailure = DefiniteProviderFailure | AmbiguousProviderFailure;

export type ProviderEvidence = {
  providerRequestId?: string;
  remoteOwnerId?: string;
  remoteMediaId?: string;
  remoteUrl?: string;
};

export type RemotePublication = {
  remoteOwnerId?: string | null;
  remoteMediaId: string;
  remoteUrl?: string | null;
};

export type MediaSource = {
  readonly sizeBytes: number;
  readonly contentType: string;
  openReadStream(input?: {
    start?: number;
    endExclusive?: number;
    signal?: AbortSignal;
  }): Promise<Readable>;
};

export type PublicationCredential = {
  getAccessToken(input?: { forceRefresh?: boolean }): Promise<string>;
};

export type PublicationCredentialSnapshot = PublicationCredential & {
  accountId: string;
  userId: string;
  platform: PublicationPlatform;
  credentialRevision: number;
  accessToken: string;
  providerAccountId: string;
  scopes: readonly string[];
};

export type PublicationContext = {
  publicationId: string;
  attemptId: string;
  operationKey: string;
  platform: PublicationPlatform;
  title: string;
  description: string | null;
  metadata: Readonly<Record<string, unknown>>;
  credential: PublicationCredentialSnapshot;
  media: MediaSource;
  signal: AbortSignal;
  evidence: Readonly<ProviderEvidence>;
  checkpointEvidence(evidence: ProviderEvidence): Promise<void>;
  reportProgress?: (progress: { uploadedBytes: number; totalBytes: number }) => void;
};

export type ReconciliationContext = Omit<PublicationContext, 'media'> & {
  media?: MediaSource;
};

export type PublicationCapabilityContext = Pick<
  PublicationContext,
  'publicationId' | 'platform' | 'credential' | 'signal'
>;

export type CapabilityOutcome =
  { kind: 'ready' } | { kind: 'failure'; failure: DefiniteProviderFailure };

export type PublishOutcome =
  | { kind: 'published'; remote: RemotePublication }
  | {
      kind: 'definite_failure';
      disposition: 'retryable' | 'terminal' | 'reauthorization_required';
      failure: DefiniteProviderFailure;
    }
  | { kind: 'ambiguous'; failure: AmbiguousProviderFailure; evidence?: ProviderEvidence };

export type ReconcileOutcome =
  | { kind: 'published'; remote: RemotePublication }
  | {
      kind: 'definitely_absent';
      disposition: 'retryable' | 'terminal';
      failure?: SafeProviderFailure;
    }
  | { kind: 'unresolved'; failure?: SafeProviderFailure }
  | { kind: 'manual_review'; failure: SafeProviderFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validFailure(value: unknown): value is SafeProviderFailure {
  if (!isRecord(value) || typeof value.code !== 'string' || value.code.trim() === '') return false;
  if (
    value.status !== undefined &&
    (!Number.isInteger(value.status) || (value.status as number) < 0)
  )
    return false;
  if (value.message !== undefined && typeof value.message !== 'string') return false;
  if (
    value.retryAfterMs !== undefined &&
    (typeof value.retryAfterMs !== 'number' ||
      !Number.isFinite(value.retryAfterMs) ||
      value.retryAfterMs < 0)
  )
    return false;
  return (
    value.classification === 'ambiguous' ||
    value.classification === 'definite_retryable' ||
    value.classification === 'definite_terminal' ||
    value.classification === 'reauthorization_required'
  );
}

function malformedPublishOutcome(): PublishOutcome {
  return {
    kind: 'ambiguous',
    failure: {
      classification: 'ambiguous',
      code: 'MALFORMED_PROVIDER_OUTCOME',
      message: 'Provider returned a malformed or contradictory publication outcome',
    },
  };
}

export function normalizePublishOutcome(value: unknown): PublishOutcome {
  if (!isRecord(value) || typeof value.kind !== 'string') return malformedPublishOutcome();
  if (value.kind === 'published') {
    if (!isRecord(value.remote) || typeof value.remote.remoteMediaId !== 'string')
      return malformedPublishOutcome();
    const remoteOwnerId = value.remote.remoteOwnerId;
    const remoteUrl = value.remote.remoteUrl;
    if (
      (remoteOwnerId !== undefined &&
        remoteOwnerId !== null &&
        typeof remoteOwnerId !== 'string') ||
      (remoteUrl !== undefined && remoteUrl !== null && typeof remoteUrl !== 'string') ||
      value.remote.remoteMediaId.trim() === ''
    )
      return malformedPublishOutcome();
    return {
      kind: 'published',
      remote: {
        remoteMediaId: value.remote.remoteMediaId,
        ...(remoteOwnerId !== undefined ? { remoteOwnerId: remoteOwnerId as string | null } : {}),
        ...(remoteUrl !== undefined ? { remoteUrl: remoteUrl as string | null } : {}),
      },
    };
  }
  if (value.kind === 'ambiguous') {
    if (!validFailure(value.failure) || value.failure.classification !== 'ambiguous')
      return malformedPublishOutcome();
    return {
      kind: 'ambiguous',
      failure: value.failure,
      ...(value.evidence !== undefined ? { evidence: value.evidence as ProviderEvidence } : {}),
    };
  }
  if (value.kind === 'definite_failure') {
    if (
      !validFailure(value.failure) ||
      value.failure.classification === 'ambiguous' ||
      (value.disposition !== 'retryable' &&
        value.disposition !== 'terminal' &&
        value.disposition !== 'reauthorization_required')
    )
      return malformedPublishOutcome();
    if (
      (value.disposition === 'retryable' &&
        value.failure.classification !== 'definite_retryable') ||
      (value.disposition === 'terminal' && value.failure.classification !== 'definite_terminal') ||
      (value.disposition === 'reauthorization_required' &&
        value.failure.classification !== 'reauthorization_required')
    )
      return malformedPublishOutcome();
    return {
      kind: 'definite_failure',
      disposition: value.disposition as 'retryable' | 'terminal' | 'reauthorization_required',
      failure: value.failure as DefiniteProviderFailure,
    };
  }
  return malformedPublishOutcome();
}

export type PublicationPublisher = {
  readonly platform: PublicationPlatform;
  readonly capabilityPreflight?: (
    context: PublicationCapabilityContext,
  ) => Promise<CapabilityOutcome>;
  readonly reconcile: (context: ReconciliationContext) => Promise<ReconcileOutcome>;
  readonly publish?: (context: PublicationContext) => Promise<PublishOutcome>;
};

export type YouTubePublisher = PublicationPublisher & {
  readonly platform: 'youtube';
};

export type VKVideoPublisher = PublicationPublisher & {
  readonly platform: 'vk';
};

export class PublicationProviderRegistry {
  readonly #providers: ReadonlyMap<PublicationPlatform, PublicationPublisher>;

  constructor(providers: readonly PublicationPublisher[] = []) {
    const entries = new Map<PublicationPlatform, PublicationPublisher>();
    for (const provider of providers) {
      if (entries.has(provider.platform))
        throw new Error(`Duplicate publication provider: ${provider.platform}`);
      entries.set(provider.platform, provider);
    }
    this.#providers = entries;
  }

  get(platform: string) {
    return this.#providers.get(platform as PublicationPlatform);
  }

  executionPlatforms() {
    return [...this.#providers.values()]
      .filter((provider) => Boolean(provider.publish))
      .map((provider) => provider.platform);
  }

  reconciliationPlatforms() {
    return [...this.#providers.keys()];
  }
}
