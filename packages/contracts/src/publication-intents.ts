import { z } from 'zod';

export const publicationIntentPlatformSchema = z.enum(['youtube', 'vk']);
export const publicationIntentModeSchema = z.enum(['DRAFT', 'PUBLISH_NOW', 'SCHEDULED']);
const utcDateTime = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith('Z'), {
    message: 'scheduledAt must be a UTC ISO-8601 timestamp',
  });

const vkOwnedHttpsUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      (hostname !== 'vk.com' && !hostname.endsWith('.vk.com'))
    )
      ctx.addIssue({ code: 'custom', message: 'link must be an HTTPS URL owned by VK' });
  });

const metadataSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(5000).optional().nullable(),
  link: vkOwnedHttpsUrl.nullable().default('https://vk.com/sovara_news'),
  createCommunityPost: z.boolean().default(false),
});

const createPublicationIntentBaseSchema = z
  .object({
    videoId: z.string().uuid(),
    platform: publicationIntentPlatformSchema,
    publishingAccountId: z.string().uuid(),
    mode: publicationIntentModeSchema,
    scheduledAt: utcDateTime.optional().nullable(),
    ...metadataSchema.shape,
  })
  .strict();
export const createPublicationIntentRequestSchema = createPublicationIntentBaseSchema.superRefine(
  (value, ctx) => {
    if (value.mode === 'SCHEDULED' && !value.scheduledAt)
      ctx.addIssue({
        code: 'custom',
        message: 'scheduledAt is required for scheduled publication',
        path: ['scheduledAt'],
      });
    if (value.mode !== 'SCHEDULED' && value.scheduledAt)
      ctx.addIssue({
        code: 'custom',
        message: 'scheduledAt is only allowed for scheduled publication',
        path: ['scheduledAt'],
      });
  },
);
export type CreatePublicationIntentRequest = z.infer<typeof createPublicationIntentRequestSchema>;

export const updatePublicationIntentRequestSchema = createPublicationIntentBaseSchema
  .omit({ videoId: true, platform: true, publishingAccountId: true })
  .extend({ link: vkOwnedHttpsUrl.nullable().optional(), revision: z.number().int().nonnegative() })
  .superRefine((value, ctx) => {
    if (value.mode === 'SCHEDULED' && !value.scheduledAt)
      ctx.addIssue({
        code: 'custom',
        message: 'scheduledAt is required for scheduled publication',
        path: ['scheduledAt'],
      });
    if (value.mode !== 'SCHEDULED' && value.scheduledAt)
      ctx.addIssue({
        code: 'custom',
        message: 'scheduledAt is only allowed for scheduled publication',
        path: ['scheduledAt'],
      });
  });
export type UpdatePublicationIntentRequest = z.infer<typeof updatePublicationIntentRequestSchema>;

export const previewUploadRequestSchema = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const previewCompleteRequestSchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict();
export const previewRemoveRequestSchema = previewCompleteRequestSchema;
export const publicationIntentParamsSchema = z.object({ intentId: z.string().uuid() }).strict();

export const publicationIntentResponseSchema = z.object({
  id: z.string().uuid(),
  videoId: z.string().uuid(),
  platform: publicationIntentPlatformSchema,
  publishingAccountId: z.string().uuid(),
  mode: publicationIntentModeSchema,
  title: z.string(),
  description: z.string().nullable(),
  link: z.string().nullable(),
  createCommunityPost: z.boolean(),
  scheduledAt: z.string().nullable(),
  preview: z
    .object({ contentType: z.string(), sizeBytes: z.number(), state: z.enum(['pending', 'ready']) })
    .nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicationIntentResponse = z.infer<typeof publicationIntentResponseSchema>;
export const previewUploadResponseSchema = z.object({
  uploadUrl: z.string().url(),
  revision: z.number().int().nonnegative(),
});
