import { z } from 'zod';

const EnvironmentSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .min(1)
      .default('postgres://sovara_runtime:sovara_runtime@localhost:15432/sovara'),
    REDIS_URL: z
      .string()
      .url()
      .refine(
        (value) => ['redis:', 'rediss:'].includes(new URL(value).protocol),
        'Redis URL required',
      )
      .default('redis://localhost:16379'),
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    PUBLICATION_QUEUE_NAME: z.string().min(1).max(128).default('sovara-publications'),
    BULLMQ_PREFIX: z.string().min(1).max(128).default('sovara-studio'),
    PUBLICATION_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    PUBLICATION_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    PUBLICATION_JOB_BACKOFF_MS: z.coerce.number().int().positive().max(3_600_000).default(5_000),
    PUBLICATION_LEASE_MS: z.coerce.number().int().positive().max(86_400_000).default(120_000),
    PUBLICATION_LEASE_HEARTBEAT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(86_400_000)
      .default(30_000),
    PUBLICATION_RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(86_400_000)
      .default(30_000),
    PUBLICATION_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
    WORKER_STARTUP_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
    WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
    CREDENTIAL_ENCRYPTION_KEYS: z.string().min(1).optional(),
    CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1).optional(),
    YOUTUBE_CLIENT_ID: z.string().min(1).optional(),
    YOUTUBE_CLIENT_SECRET: z.string().min(1).optional(),
    YOUTUBE_REDIRECT_URI: z.string().url().optional(),
    VK_CLIENT_ID: z.string().min(1).optional(),
    VK_SERVICE_TOKEN: z.string().min(1).optional(),
    VK_REDIRECT_URI: z.string().url().optional(),
    VK_GROUP_ID: z
      .string()
      .regex(/^[1-9]\d*$/)
      .refine(
        (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
        'VK group ID is too large',
      )
      .optional(),
    VK_CAPABILITY_TIMEOUT_MS: z.coerce.number().int().min(10).max(120_000).default(10_000),
    VK_SAVE_TIMEOUT_MS: z.coerce.number().int().min(10).max(120_000).default(15_000),
    VK_GET_TIMEOUT_MS: z.coerce.number().int().min(10).max(120_000).default(15_000),
    VK_DNS_TIMEOUT_MS: z.coerce.number().int().min(10).max(30_000).default(5_000),
    VK_UPLOAD_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(21_600_000),
    VK_RESPONSE_READ_TIMEOUT_MS: z.coerce.number().int().min(10).max(120_000).default(15_000),
    YOUTUBE_UPLOAD_CHUNK_BYTES: z.coerce
      .number()
      .int()
      .min(262_144)
      .max(64 * 1024 * 1024)
      .default(8 * 1024 * 1024),
    YOUTUBE_MAX_STATUS_PROBES: z.coerce.number().int().min(1).max(10).default(3),
    S3_ENDPOINT: z.string().url().default('http://localhost:19000'),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ACCESS_KEY_ID: z.string().min(1).default('minioadmin'),
    S3_SECRET_ACCESS_KEY: z.string().min(1).default('minioadmin'),
    S3_BUCKET: z.string().min(1).default('sovara-uploads'),
    S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
    PUBLICATION_COMPLETED_RETENTION_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .default(3_600),
    PUBLICATION_FAILED_RETENTION_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .default(604_800),
  })
  .superRefine((value, context) => {
    if (value.PUBLICATION_LEASE_HEARTBEAT_MS >= value.PUBLICATION_LEASE_MS)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Lease heartbeat must be less than lease duration',
      });
    const vkConfiguration = [
      value.VK_CLIENT_ID,
      value.VK_SERVICE_TOKEN,
      value.VK_REDIRECT_URI,
      value.VK_GROUP_ID,
    ];
    if (vkConfiguration.some(Boolean) && vkConfiguration.some((entry) => !entry))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'VK publication configuration requires client ID, service token, redirect URI, and group ID',
      });
  });

export function parseWorkerEnvironment(values: Record<string, string | undefined>) {
  return EnvironmentSchema.parse(values);
}

export const environment = parseWorkerEnvironment({
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  WORKER_PORT: process.env.WORKER_PORT,
  PUBLICATION_QUEUE_NAME: process.env.PUBLICATION_QUEUE_NAME,
  BULLMQ_PREFIX: process.env.BULLMQ_PREFIX,
  PUBLICATION_WORKER_CONCURRENCY: process.env.PUBLICATION_WORKER_CONCURRENCY,
  PUBLICATION_JOB_ATTEMPTS: process.env.PUBLICATION_JOB_ATTEMPTS,
  PUBLICATION_JOB_BACKOFF_MS: process.env.PUBLICATION_JOB_BACKOFF_MS,
  PUBLICATION_LEASE_MS: process.env.PUBLICATION_LEASE_MS,
  PUBLICATION_LEASE_HEARTBEAT_MS: process.env.PUBLICATION_LEASE_HEARTBEAT_MS,
  PUBLICATION_RECONCILE_INTERVAL_MS: process.env.PUBLICATION_RECONCILE_INTERVAL_MS,
  PUBLICATION_RECONCILE_BATCH_SIZE: process.env.PUBLICATION_RECONCILE_BATCH_SIZE,
  WORKER_STARTUP_TIMEOUT_MS: process.env.WORKER_STARTUP_TIMEOUT_MS,
  WORKER_SHUTDOWN_TIMEOUT_MS: process.env.WORKER_SHUTDOWN_TIMEOUT_MS,
  CREDENTIAL_ENCRYPTION_KEYS: process.env.CREDENTIAL_ENCRYPTION_KEYS,
  CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: process.env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI,
  VK_CLIENT_ID: process.env.VK_CLIENT_ID,
  VK_SERVICE_TOKEN: process.env.VK_SERVICE_TOKEN,
  VK_REDIRECT_URI: process.env.VK_REDIRECT_URI,
  VK_GROUP_ID: process.env.VK_GROUP_ID,
  VK_CAPABILITY_TIMEOUT_MS: process.env.VK_CAPABILITY_TIMEOUT_MS,
  VK_SAVE_TIMEOUT_MS: process.env.VK_SAVE_TIMEOUT_MS,
  VK_GET_TIMEOUT_MS: process.env.VK_GET_TIMEOUT_MS,
  VK_DNS_TIMEOUT_MS: process.env.VK_DNS_TIMEOUT_MS,
  VK_UPLOAD_TIMEOUT_MS: process.env.VK_UPLOAD_TIMEOUT_MS,
  VK_RESPONSE_READ_TIMEOUT_MS: process.env.VK_RESPONSE_READ_TIMEOUT_MS,
  YOUTUBE_UPLOAD_CHUNK_BYTES: process.env.YOUTUBE_UPLOAD_CHUNK_BYTES,
  YOUTUBE_MAX_STATUS_PROBES: process.env.YOUTUBE_MAX_STATUS_PROBES,
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
  PUBLICATION_COMPLETED_RETENTION_SECONDS: process.env.PUBLICATION_COMPLETED_RETENTION_SECONDS,
  PUBLICATION_FAILED_RETENTION_SECONDS: process.env.PUBLICATION_FAILED_RETENTION_SECONDS,
});
