import { createHash } from 'node:crypto';

export type PublicationRetryPolicyConfig = {
  maxProviderAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryWindowMs: number;
  reconciliationDelayMs: number;
  reconciliationMaxAgeMs: number;
  maxProviderRetryAfterMs: number;
};

export function calculateRetryAt(
  input: {
    attemptId: string;
    attemptCount: number;
    createdAt: Date;
    now?: Date;
    retryAfterMs?: number;
  },
  config: PublicationRetryPolicyConfig,
) {
  const now = input.now ?? new Date();
  if (input.attemptCount >= config.maxProviderAttempts) return null;
  if (now.getTime() - input.createdAt.getTime() >= config.maxRetryWindowMs) return null;
  const exponential = Math.min(
    config.maxDelayMs,
    config.baseDelayMs * 2 ** Math.max(0, input.attemptCount - 1),
  );
  const digest = createHash('sha256').update(input.attemptId).digest().readUInt32BE(0);
  const jitter = Math.floor(exponential * ((digest % 21) / 100));
  const providerDelay = Math.min(config.maxProviderRetryAfterMs, input.retryAfterMs ?? 0);
  const delay = Math.min(config.maxDelayMs, Math.max(exponential + jitter, providerDelay));
  return new Date(now.getTime() + delay);
}

export function calculateReconciliationAt(now: Date, config: PublicationRetryPolicyConfig) {
  return new Date(now.getTime() + config.reconciliationDelayMs);
}

export function reconciliationExpired(
  requiredAt: Date,
  now: Date,
  config: PublicationRetryPolicyConfig,
) {
  return now.getTime() - requiredAt.getTime() >= config.reconciliationMaxAgeMs;
}
