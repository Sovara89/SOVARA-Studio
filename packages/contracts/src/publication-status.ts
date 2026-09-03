import { z } from 'zod';
import { publicationIntentPlatformSchema } from './publication-intents.js';

export const publicationStatusResponseSchema = z.object({
  id: z.string().uuid(),
  videoId: z.string().uuid(),
  platform: publicationIntentPlatformSchema,
  publishingAccountId: z.string().uuid(),
  state: z.enum([
    'queued',
    'publishing',
    'reconciling',
    'retry_wait',
    'manual_review',
    'published',
    'failed',
    'cancelled',
  ]),
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  result: z
    .object({ remoteMediaId: z.string(), remoteUrl: z.string().url().nullable() })
    .nullable(),
  error: z
    .object({ code: z.string(), message: z.string().nullable(), retryable: z.boolean() })
    .nullable(),
  updatedAt: z.string(),
});
export const publicationStatusListResponseSchema = z.array(publicationStatusResponseSchema);
export type PublicationStatusResponse = z.infer<typeof publicationStatusResponseSchema>;
