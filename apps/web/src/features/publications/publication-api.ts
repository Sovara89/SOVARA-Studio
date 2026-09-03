import {
  createPublicationIntentRequestSchema,
  publicationIntentResponseSchema,
  publicationStatusListResponseSchema,
  type CreatePublicationIntentRequest,
  type PublicationStatusResponse,
} from '@sovara-studio/contracts';
import { apiBaseUrl } from '../../env';
export type { PublicationStatusResponse } from '@sovara-studio/contracts';
export type PublishingAccount = {
  id: string;
  platform: 'youtube' | 'vk';
  displayName: string | null;
  status: string;
};
async function json(response: Response) {
  const body = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new Error(
      (body as { error?: { message?: string } })?.error?.message ?? 'Studio request failed',
    );
  return body;
}
export async function listAccounts() {
  return json(
    await fetch(`${apiBaseUrl}/publishing-accounts`, { credentials: 'same-origin' }),
  ) as Promise<PublishingAccount[]>;
}
export async function createIntent(input: CreatePublicationIntentRequest) {
  const response = await fetch(`${apiBaseUrl}/publication-intents`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createPublicationIntentRequestSchema.parse(input)),
  });
  return publicationIntentResponseSchema.parse(await json(response));
}
export async function listPublicationStatus(): Promise<PublicationStatusResponse[]> {
  return publicationStatusListResponseSchema.parse(
    await json(await fetch(`${apiBaseUrl}/publication-status`, { credentials: 'same-origin' })),
  );
}
export async function uploadPreview(intentId: string, file: File, revision: number) {
  const response = await fetch(`${apiBaseUrl}/publication-intents/${intentId}/preview`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contentType: file.type, sizeBytes: file.size, revision }),
  });
  const prepared = (await json(response)) as { uploadUrl: string; revision: number };
  const put = await fetch(prepared.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!put.ok) throw new Error('Preview upload failed');
  const complete = await fetch(`${apiBaseUrl}/publication-intents/${intentId}/preview/complete`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: prepared.revision }),
  });
  return publicationIntentResponseSchema.parse(await json(complete));
}
export async function removePreview(intentId: string, revision: number) {
  const response = await fetch(`${apiBaseUrl}/publication-intents/${intentId}/preview`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision }),
  });
  return publicationIntentResponseSchema.parse(await json(response));
}
