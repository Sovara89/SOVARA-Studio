import Redis from 'ioredis';
import { S3Client } from '@aws-sdk/client-s3';
import type { RedisConnectionRole, RedisOptions, S3Options } from './types.js';
export type RedisClient = Redis;
export const createRedisClient = (options: RedisOptions): RedisClient =>
  new Redis({
    host: options.host,
    port: options.port,
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });

export const createRedisUrlClient = (
  url: string,
  role: RedisConnectionRole,
  connectTimeoutMs = 10_000,
): RedisClient =>
  new Redis(url, {
    connectTimeout: connectTimeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: role === 'worker' ? null : 1,
    retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
  });
export const createS3Client = (options: S3Options): S3Client =>
  new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle ?? false,
    maxAttempts: options.maxAttempts ?? 3,
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
  });
