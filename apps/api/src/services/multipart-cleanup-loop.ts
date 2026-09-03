import type { createMultipartUploadRepository } from '@sovara-studio/db';
import type { createMultipartUploadService } from './multipart-upload-service.js';

type UploadRepository = ReturnType<typeof createMultipartUploadRepository>;
type UploadService = ReturnType<typeof createMultipartUploadService>;

export type MultipartCleanupLoopOptions = {
  uploads: UploadRepository;
  service: UploadService;
  intervalMs: number;
  batchSize: number;
  claimTimeoutMs: number;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

export function createMultipartCleanupLoop(options: MultipartCleanupLoopOptions) {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let currentRun: Promise<{ cleaned: number; failed: number }> | undefined;
  let closed = false;

  const execute = async () => {
    let cleaned = 0;
    let failed = 0;
    const currentTime = now();
    const abortPendingBefore = new Date(currentTime.getTime() - options.claimTimeoutMs);
    try {
      await options.service.recoverPendingInitiations(options.batchSize, abortPendingBefore);
    } catch {
      failed += 1;
      log('multipart_initiation_recovery_failed', {});
    }

    const candidates = await options.uploads.listCleanupCandidates({
      now: currentTime,
      abortPendingBefore,
      limit: options.batchSize,
    });
    for (const candidate of candidates) {
      if (closed) break;
      const upload = candidate.upload;
      const claimed = await options.uploads.claimCleanupCandidate(
        upload.userId,
        upload.id,
        upload.state as 'active' | 'completing' | 'abort_pending' | 'failed',
        upload.revision,
        currentTime,
        abortPendingBefore,
      );
      if (!claimed[0]) continue;
      try {
        await options.service.cleanupExpired(upload.userId, upload.videoId, upload.id);
        cleaned += 1;
        log('multipart_cleanup_completed', { uploadId: upload.id, videoId: upload.videoId });
      } catch {
        failed += 1;
        log('multipart_cleanup_failed', { uploadId: upload.id, videoId: upload.videoId });
      }
    }
    return { cleaned, failed };
  };

  const runOnce = () => {
    if (closed) return Promise.resolve({ cleaned: 0, failed: 0 });
    currentRun ??= execute().finally(() => {
      currentRun = undefined;
    });
    return currentRun;
  };

  return {
    runOnce,
    start: async () => {
      if (closed || timer) return;
      await runOnce().catch(() => log('multipart_cleanup_pass_failed', {}));
      if (closed) return;
      timer = setInterval(
        () => void runOnce().catch(() => log('multipart_cleanup_pass_failed', {})),
        options.intervalMs,
      );
    },
    close: async () => {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (currentRun) await currentRun;
    },
  };
}
