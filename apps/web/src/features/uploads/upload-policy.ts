export const DEFAULT_FRONTEND_MAX_CONCURRENCY = 3;
export const DEFAULT_SIGNING_WINDOW = 4;
export const DEFAULT_RETRY_ATTEMPTS = 5;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
export const DEFAULT_PRESIGNED_URL_SKEW_MS = 5_000;
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;

export type UploadPolicy = {
  maxConcurrency: number;
  signingWindow: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  presignedUrlSkewMs: number;
  inactivityTimeoutMs: number;
};

export const defaultUploadPolicy: UploadPolicy = {
  maxConcurrency: DEFAULT_FRONTEND_MAX_CONCURRENCY,
  signingWindow: DEFAULT_SIGNING_WINDOW,
  maxAttempts: DEFAULT_RETRY_ATTEMPTS,
  retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
  presignedUrlSkewMs: DEFAULT_PRESIGNED_URL_SKEW_MS,
  inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS,
};
