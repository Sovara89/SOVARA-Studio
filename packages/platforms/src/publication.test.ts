import { describe, expect, test, vi } from 'vitest';
import { normalizePublishOutcome, PublicationProviderRegistry } from './publication.js';

function provider(platform: 'youtube' | 'vk', publish?: boolean) {
  return {
    platform,
    ...(publish ? { publish: vi.fn() } : {}),
    reconcile: vi.fn(),
  } as never;
}

describe('publication provider registry', () => {
  test('separates execution and reconciliation capabilities', () => {
    const registry = new PublicationProviderRegistry([provider('youtube', true), provider('vk')]);
    expect(registry.executionPlatforms()).toEqual(['youtube']);
    expect(registry.reconciliationPlatforms()).toEqual(['youtube', 'vk']);
    expect(registry.get('youtube')).toBeTruthy();
  });

  test('rejects duplicate platforms', () => {
    expect(
      () => new PublicationProviderRegistry([provider('youtube'), provider('youtube')]),
    ).toThrow(/Duplicate/);
  });
});

describe('publication outcome boundary', () => {
  test('converts contradictory provider outcomes to ambiguous failure', () => {
    expect(
      normalizePublishOutcome({
        kind: 'definite_failure',
        disposition: 'terminal',
        failure: {
          classification: 'ambiguous',
          code: 'provider-timeout',
        },
      }),
    ).toEqual({
      kind: 'ambiguous',
      failure: {
        classification: 'ambiguous',
        code: 'MALFORMED_PROVIDER_OUTCOME',
        message: 'Provider returned a malformed or contradictory publication outcome',
      },
    });
  });

  test('preserves a coherent definite failure', () => {
    expect(
      normalizePublishOutcome({
        kind: 'definite_failure',
        disposition: 'retryable',
        failure: {
          classification: 'definite_retryable',
          code: 'rate_limited',
          retryAfterMs: 250,
        },
      }),
    ).toMatchObject({
      kind: 'definite_failure',
      disposition: 'retryable',
      failure: { classification: 'definite_retryable', code: 'rate_limited' },
    });
  });
});
