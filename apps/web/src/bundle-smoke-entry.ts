import { createUploadApi } from './lib/upload-api';

const representativeStatus = {
  videoId: '00000000-0000-4000-8000-000000000001',
  uploadId: '00000000-0000-4000-8000-000000000002',
  state: 'active',
  expectedSizeBytes: 12,
  partSizeBytes: 6,
  expectedPartCount: 2,
  expiresAt: '2026-08-31T00:00:00.000Z',
  revision: 3,
  maxConcurrency: 2,
  parts: [
    {
      partNumber: 1,
      etag: '"part-1"',
      reportedSizeBytes: 6,
      providerChecksumAlgorithm: null,
      providerChecksumValue: null,
      revision: 3,
    },
  ],
};

export async function runBundleSmoke() {
  const api = createUploadApi({
    baseUrl: '/api',
    fetchImpl: async () =>
      new Response(JSON.stringify(representativeStatus), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  return api.getStatus(representativeStatus.videoId, representativeStatus.uploadId);
}
