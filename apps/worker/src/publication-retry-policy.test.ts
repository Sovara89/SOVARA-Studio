import { describe, expect, test } from 'vitest';
import {
  calculateReconciliationAt,
  calculateRetryAt,
  reconciliationExpired,
  type PublicationRetryPolicyConfig,
} from './publication-retry-policy.js';

const config: PublicationRetryPolicyConfig = {
  maxProviderAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxRetryWindowMs: 10_000,
  reconciliationDelayMs: 500,
  reconciliationMaxAgeMs: 2_000,
  maxProviderRetryAfterMs: 1_000,
};

describe('publication retry policy', () => {
  test('bounds attempts and produces deterministic retry times', () => {
    const input = {
      attemptId: 'attempt-1',
      attemptCount: 1,
      createdAt: new Date(0),
      now: new Date(0),
    };
    expect(calculateRetryAt(input, config)).toEqual(calculateRetryAt(input, config));
    expect(calculateRetryAt({ ...input, attemptCount: 3 }, config)).toBeNull();
    expect(calculateRetryAt({ ...input, now: new Date(10_000) }, config)).toBeNull();
  });

  test('honors a bounded provider retry hint', () => {
    const retryAt = calculateRetryAt(
      {
        attemptId: 'attempt-2',
        attemptCount: 1,
        createdAt: new Date(0),
        now: new Date(0),
        retryAfterMs: 800,
      },
      config,
    );
    expect(retryAt!.getTime()).toBeGreaterThanOrEqual(800);
    expect(retryAt!.getTime()).toBeLessThanOrEqual(1_000);
  });

  test('calculates reconciliation scheduling and age', () => {
    const next = calculateReconciliationAt(new Date(100), config);
    expect(next.getTime()).toBe(600);
    expect(reconciliationExpired(new Date(0), new Date(1_999), config)).toBe(false);
    expect(reconciliationExpired(new Date(0), new Date(2_000), config)).toBe(true);
  });
});
