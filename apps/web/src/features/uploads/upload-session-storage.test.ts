import { describe, expect, test } from 'vitest';
import { createUploadSessionStorage } from './upload-session-storage';

describe('upload session storage', () => {
  test('persists only safe reload identifiers and fingerprint', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
    const sessions = createUploadSessionStorage(storage);
    sessions.save({ videoId: 'video', uploadId: 'upload', resumeFingerprint: 'fingerprint' });
    expect(sessions.load()).toMatchObject({
      videoId: 'video',
      uploadId: 'upload',
      resumeFingerprint: 'fingerprint',
    });
    expect(values.values().next().value).not.toContain('ETag');
    expect(values.values().next().value).not.toContain('presign');
    sessions.clear();
    expect(sessions.load()).toBeNull();
  });
});
