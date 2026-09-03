import { describe, expect, test } from 'vitest';
import {
  S3_MAX_PART_SIZE_BYTES,
  calculateMultipartPlan,
  expectedPartSize,
  parseStorageConfiguration,
} from './storage-config.js';

const baseEnvironment = {
  S3_ENDPOINT: 'http://localhost:19000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin',
  S3_BUCKET: 'sovara-uploads',
  S3_FORCE_PATH_STYLE: 'true',
  S3_PRESIGNED_PART_TTL_SECONDS: '900',
  S3_MULTIPART_UPLOAD_TTL_SECONDS: '86400',
  UPLOAD_MAX_SIZE_BYTES: String(100 * 1024 ** 3),
  UPLOAD_MIN_PART_SIZE_BYTES: String(5 * 1024 ** 2),
  UPLOAD_PREFERRED_PART_SIZE_BYTES: String(64 * 1024 ** 2),
  UPLOAD_TARGET_MAX_PARTS: '1000',
  UPLOAD_SIGN_BATCH_MAX: '16',
  UPLOAD_MAX_CONCURRENCY: '6',
  UPLOAD_SIGN_RATE_LIMIT_PER_MINUTE: '120',
};

describe('storage configuration', () => {
  test('calculates a comfortable part count for tens-of-GB videos', () => {
    const configuration = parseStorageConfiguration(baseEnvironment);
    const plan = calculateMultipartPlan(50 * 1024 ** 3, configuration);
    expect(plan.partSizeBytes).toBe(64 * 1024 ** 2);
    expect(plan.expectedPartCount).toBe(800);
  });

  test('raises part size to satisfy the configured target part count', () => {
    const configuration = parseStorageConfiguration({
      ...baseEnvironment,
      UPLOAD_PREFERRED_PART_SIZE_BYTES: String(5 * 1024 ** 2),
      UPLOAD_TARGET_MAX_PARTS: '100',
    });
    const plan = calculateMultipartPlan(60 * 1024 ** 3, configuration);
    expect(plan.partSizeBytes).toBe(615 * 1024 ** 2);
    expect(plan.expectedPartCount).toBe(100);
  });

  test('keeps the hard ten-thousand-part constraint', () => {
    const configuration = parseStorageConfiguration({
      ...baseEnvironment,
      UPLOAD_MAX_SIZE_BYTES: String(50 * 1024 ** 3),
      UPLOAD_PREFERRED_PART_SIZE_BYTES: String(5 * 1024 ** 2),
      UPLOAD_TARGET_MAX_PARTS: '10000',
    });
    const plan = calculateMultipartPlan(50 * 1024 ** 3, configuration);
    expect(plan.expectedPartCount).toBeLessThanOrEqual(10_000);
    expect(plan.partSizeBytes % (1024 * 1024)).toBe(0);
  });

  test('rejects a file over the configured maximum', () => {
    const configuration = parseStorageConfiguration(baseEnvironment);
    expect(() => calculateMultipartPlan(101 * 1024 ** 3, configuration)).toThrow(
      'exceeds configured maximum',
    );
  });

  test('rejects invalid credential pairs and impossible part sizes', () => {
    expect(() =>
      parseStorageConfiguration({
        ...baseEnvironment,
        S3_ACCESS_KEY_ID: undefined,
      }),
    ).toThrow('supplied together');
    expect(() =>
      parseStorageConfiguration({
        ...baseEnvironment,
        UPLOAD_PREFERRED_PART_SIZE_BYTES: String(S3_MAX_PART_SIZE_BYTES + 1),
      }),
    ).toThrow('exceeds S3 maximum');
  });

  test('calculates the exact final part size', () => {
    expect(expectedPartSize(10 * 1024 * 1024, 5 * 1024 * 1024, 2, 1)).toBe(5 * 1024 * 1024);
    expect(expectedPartSize(10 * 1024 * 1024 + 1, 5 * 1024 * 1024, 3, 3)).toBe(1);
  });

  test('parses conservative extension and content-type allowlists', () => {
    const configuration = parseStorageConfiguration({
      ...baseEnvironment,
      UPLOAD_ALLOWED_EXTENSIONS: 'MP4, .MOV, mp4',
      UPLOAD_ALLOWED_CONTENT_TYPES: 'VIDEO/MP4, application/octet-stream',
    });
    expect(configuration.uploadAllowedExtensions).toEqual(['mp4', 'mov']);
    expect(configuration.uploadAllowedContentTypes).toEqual([
      'video/mp4',
      'application/octet-stream',
    ]);
  });
});
