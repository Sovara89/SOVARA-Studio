import { RESUME_FINGERPRINT_VERSION } from './file-resume-fingerprint';

export type StoredUploadSession = {
  version: typeof RESUME_FINGERPRINT_VERSION;
  videoId: string;
  uploadId: string;
  resumeFingerprint: string;
};

const KEY = 'sovara-studio:upload-session';

export function createUploadSessionStorage(
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
) {
  return {
    load(): StoredUploadSession | null {
      if (!storage) return null;
      const raw = storage.getItem(KEY);
      if (!raw) return null;
      try {
        const value: unknown = JSON.parse(raw);
        if (
          typeof value !== 'object' ||
          value === null ||
          (value as StoredUploadSession).version !== RESUME_FINGERPRINT_VERSION ||
          typeof (value as StoredUploadSession).videoId !== 'string' ||
          typeof (value as StoredUploadSession).uploadId !== 'string' ||
          typeof (value as StoredUploadSession).resumeFingerprint !== 'string'
        )
          return null;
        return value as StoredUploadSession;
      } catch {
        return null;
      }
    },
    save(session: Omit<StoredUploadSession, 'version'>) {
      if (!storage) return;
      storage.setItem(KEY, JSON.stringify({ version: RESUME_FINGERPRINT_VERSION, ...session }));
    },
    clear() {
      if (!storage) return;
      storage.removeItem(KEY);
    },
  };
}
