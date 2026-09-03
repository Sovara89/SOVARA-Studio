import { z } from 'zod';

export const publicationJobName = 'process-publication' as const;
export const publicationJobPayloadSchema = z
  .object({
    publicationId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export type PublicationJobPayload = z.infer<typeof publicationJobPayloadSchema>;
