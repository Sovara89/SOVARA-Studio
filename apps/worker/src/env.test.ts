import { describe, expect, test } from 'vitest';
import { parseWorkerEnvironment } from './env.js';

describe('worker configuration', () => {
  test('accepts bounded local worker configuration', () => {
    expect(
      parseWorkerEnvironment({
        DATABASE_URL: 'postgres://localhost/sovara',
        REDIS_URL: 'redis://localhost:6379',
        PUBLICATION_LEASE_MS: '1000',
        PUBLICATION_LEASE_HEARTBEAT_MS: '500',
      }),
    ).toMatchObject({
      DATABASE_URL: 'postgres://localhost/sovara',
      REDIS_URL: 'redis://localhost:6379',
      PUBLICATION_LEASE_MS: 1000,
    });
  });

  test('rejects a heartbeat that can outlive its lease', () => {
    expect(() =>
      parseWorkerEnvironment({
        REDIS_URL: 'redis://localhost:6379',
        PUBLICATION_LEASE_MS: '1000',
        PUBLICATION_LEASE_HEARTBEAT_MS: '1000',
      }),
    ).toThrow(/heartbeat/i);
  });

  test('rejects non-Redis URLs', () => {
    expect(() => parseWorkerEnvironment({ REDIS_URL: 'https://localhost:6379' })).toThrow(
      /Redis URL/i,
    );
  });

  test('requires complete VK community publication configuration', () => {
    expect(() =>
      parseWorkerEnvironment({
        VK_CLIENT_ID: 'vk-client',
        VK_SERVICE_TOKEN: 'vk-service-token',
      }),
    ).toThrow(/VK publication configuration/i);
    expect(
      parseWorkerEnvironment({
        VK_CLIENT_ID: 'vk-client',
        VK_SERVICE_TOKEN: 'vk-service-token',
        VK_REDIRECT_URI: 'https://studio.example/vk/callback',
        VK_GROUP_ID: '54321',
      }),
    ).toMatchObject({
      VK_CLIENT_ID: 'vk-client',
      VK_SERVICE_TOKEN: 'vk-service-token',
      VK_REDIRECT_URI: 'https://studio.example/vk/callback',
      VK_GROUP_ID: '54321',
    });
  });

  test.each(['0', '-54321', '054321', 'group', '9007199254740992'])(
    'rejects non-canonical VK_GROUP_ID %s',
    (groupId) => {
      expect(() =>
        parseWorkerEnvironment({
          VK_CLIENT_ID: 'vk-client',
          VK_SERVICE_TOKEN: 'vk-service-token',
          VK_REDIRECT_URI: 'https://studio.example/vk/callback',
          VK_GROUP_ID: groupId,
        }),
      ).toThrow();
    },
  );
});
