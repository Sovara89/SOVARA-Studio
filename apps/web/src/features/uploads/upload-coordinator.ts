import type { PartUrlResponse, UploadStatusResponse } from '@sovara-studio/contracts';
import { createUploadApi, UploadApiError, type UploadApi } from '../../lib/upload-api';
import { DirectPutError, uploadPartDirectly } from '../../lib/s3-upload-transport';
import { computeResumeFingerprint } from './file-resume-fingerprint';
import { calculatePartRange } from './part-ranges';
import { defaultUploadPolicy, type UploadPolicy } from './upload-policy';
import {
  uploadMachineReducer,
  initialUploadMachineState,
  type PartView,
  type UploadMachineAction,
  type UploadMachineState,
} from './upload-machine';
import { createUploadSessionStorage, type StoredUploadSession } from './upload-session-storage';

export type UploadTransport = (input: {
  url: string;
  body: Blob;
  signal: AbortSignal;
  onProgress: (loadedBytes: number, totalBytes: number) => void;
  inactivityTimeoutMs: number;
}) => Promise<{ etag: string }>;

export type UploadCoordinatorOptions = {
  api?: UploadApi;
  transport?: UploadTransport;
  sessions?: ReturnType<typeof createUploadSessionStorage>;
  policy?: Partial<UploadPolicy>;
  dispatch?: (action: UploadMachineAction) => void;
};

class CancelledError extends Error {
  constructor() {
    super('Upload operation was cancelled');
    this.name = 'CancelledError';
  }
}

type TimerWaiter = { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void };

function effectivePolicy(input?: Partial<UploadPolicy>): UploadPolicy {
  return { ...defaultUploadPolicy, ...input };
}

function errorCategory(error: unknown) {
  if (error instanceof UploadApiError) {
    if (error.code === 'UNAUTHORIZED') return 'session_expired';
    if (error.code === 'UPLOAD_TOO_LARGE') return 'upload_too_large';
    if (error.code === 'INVALID_REQUEST' || error.code === 'INVALID_PART') return 'invalid_file';
    if (error.code === 'INVALID_UPLOAD_STATE') return 'invalid_state';
    if (error.code === 'UPLOAD_EXPIRED') return 'upload_expired';
    if (error.code === 'STALE_REVISION') return 'stale_conflict';
    if (error.code === 'SIGNING_RATE_LIMITED') return 'signing_limited';
    if (error.code === 'PROVIDER_CLEANUP_REQUIRED') return 'provider_cleanup_pending';
    if (error.code === 'STORAGE_TEMPORARILY_UNAVAILABLE') return 'storage_temporary';
  }
  if (error instanceof DirectPutError) {
    if (error.kind === 'missing_etag') return 'protocol_error';
    if (error.kind === 'aborted') return 'cancelled';
    return 'provider_put_failure';
  }
  return 'unknown_error';
}

function retryable(error: unknown) {
  if (error instanceof UploadApiError)
    return error.retryable || error.status === 429 || error.status >= 500;
  if (error instanceof DirectPutError)
    return (
      error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.status === 429 ||
      (error.status ?? 0) >= 500
    );
  return false;
}

function isLikelyExpired(error: unknown) {
  return error instanceof DirectPutError && (error.status === 401 || error.status === 403);
}

function messageFor(error: unknown) {
  if (error instanceof UploadApiError || error instanceof DirectPutError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'The upload could not continue. Retry the failed upload.';
}

function makeParts(status: UploadStatusResponse): {
  parts: Record<number, PartView>;
  confirmedBytes: number;
} {
  const recorded = new Set(status.parts.map((part) => part.partNumber));
  const parts: Record<number, PartView> = {};
  let confirmedBytes = 0;
  for (let partNumber = 1; partNumber <= status.expectedPartCount; partNumber += 1) {
    const range = calculatePartRange(
      status.expectedSizeBytes,
      status.partSizeBytes,
      status.expectedPartCount,
      partNumber,
    );
    const isRecorded = recorded.has(partNumber);
    if (isRecorded) confirmedBytes += range.size;
    parts[partNumber] = {
      partNumber,
      sizeBytes: range.size,
      phase: isRecorded ? 'recorded' : 'pending',
      loadedBytes: isRecorded ? range.size : 0,
      attempt: 0,
    };
  }
  return { parts, confirmedBytes };
}

function assertFileMatches(file: File, status: UploadStatusResponse) {
  if (!Number.isSafeInteger(file.size) || file.size !== status.expectedSizeBytes)
    throw new Error('Selected file size does not match this upload');
  calculatePartRange(
    file.size,
    status.partSizeBytes,
    status.expectedPartCount,
    status.expectedPartCount,
  );
}

export class UploadCoordinator {
  private readonly api: UploadApi;
  private readonly transport: UploadTransport;
  private readonly sessions: ReturnType<typeof createUploadSessionStorage>;
  private readonly policy: UploadPolicy;
  private readonly dispatchAction: (action: UploadMachineAction) => void;
  private readonly controllers = new Set<AbortController>();
  private readonly timers = new Set<TimerWaiter>();
  private state: UploadMachineState = initialUploadMachineState;
  private session: StoredUploadSession | null = null;
  private currentFile: File | undefined;
  private generation = 0;
  private runningGeneration: number | null = null;
  private paused = false;
  private fatal = false;

  constructor(options: UploadCoordinatorOptions = {}) {
    this.api = options.api ?? createUploadApi();
    this.transport = options.transport ?? (uploadPartDirectly as UploadTransport);
    this.sessions = options.sessions ?? createUploadSessionStorage();
    this.policy = effectivePolicy(options.policy);
    this.dispatchAction = (action) => {
      this.state = uploadMachineReducer(this.state, action);
      options.dispatch?.(action);
    };
  }

  getState() {
    return this.state;
  }

  getStoredSession() {
    return this.session ?? this.sessions.load();
  }

  async start(file: File) {
    this.stopLocalWork();
    this.currentFile = file;
    this.paused = false;
    this.fatal = false;
    this.dispatchAction({ type: 'creating', file });
    const operationGeneration = this.generation;
    try {
      const resumeFingerprint = await computeResumeFingerprint(file);
      this.assertCurrent(operationGeneration);
      const created = await this.api.createUpload({
        originalFilename: file.name,
        contentType: file.type || 'application/octet-stream',
        expectedSizeBytes: file.size,
      });
      if (this.isCancelled(operationGeneration)) {
        await this.cleanupLateCreatedUpload(created.videoId, created.upload.uploadId);
        throw new CancelledError();
      }
      this.session = {
        version: 1,
        videoId: created.videoId,
        uploadId: created.upload.uploadId,
        resumeFingerprint,
      };
      this.sessions.save(this.session);
      this.assertCurrent(operationGeneration);
      const status = await this.api.getStatus(created.videoId, created.upload.uploadId);
      this.assertCurrent(operationGeneration);
      const prepared = makeParts(status);
      this.dispatchAction({
        type: 'session_created',
        videoId: created.videoId,
        uploadId: created.upload.uploadId,
        status,
        parts: prepared.parts,
        confirmedBytes: prepared.confirmedBytes,
      });
      await this.run(file, status);
    } catch (error) {
      if (!this.isCurrentGeneration(operationGeneration)) return;
      this.handleFailure(error);
    }
  }

  async resume(file: File, stored = this.getStoredSession()) {
    this.stopLocalWork();
    this.currentFile = file;
    this.paused = false;
    this.fatal = false;
    if (!stored) {
      this.handleFailure(new Error('No saved upload session is available'));
      return;
    }
    this.session = stored;
    this.dispatchAction({ type: 'creating', file });
    const operationGeneration = this.generation;
    try {
      const status = await this.api.getStatus(stored.videoId, stored.uploadId);
      this.assertCurrent(operationGeneration);
      assertFileMatches(file, status);
      const fingerprint = await computeResumeFingerprint(file);
      this.assertCurrent(operationGeneration);
      if (fingerprint !== stored.resumeFingerprint)
        throw new Error('Selected file does not match this upload');
      this.assertCurrent(operationGeneration);
      const prepared = makeParts(status);
      this.dispatchAction({
        type: 'status_loaded',
        status,
        parts: prepared.parts,
        confirmedBytes: prepared.confirmedBytes,
      });
      await this.run(file, status);
    } catch (error) {
      if (!this.isCurrentGeneration(operationGeneration)) return;
      this.handleFailure(
        error,
        error instanceof Error && error.message === 'Selected file does not match this upload'
          ? 'file_mismatch'
          : undefined,
      );
    }
  }

  pause() {
    if (this.runningGeneration === null || this.state.phase === 'paused') return;
    this.paused = true;
    this.generation += 1;
    this.abortActiveRequests();
    this.rejectTimers();
    this.dispatchAction({ type: 'paused' });
  }

  async retry() {
    if (!this.currentFile) return;
    await this.resume(this.currentFile);
  }

  async cancel() {
    const session = this.session ?? this.sessions.load();
    this.paused = true;
    const cancellationGeneration = ++this.generation;
    this.abortActiveRequests();
    this.rejectTimers();
    this.dispatchAction({ type: 'aborting' });
    if (!session) {
      this.dispatchAction({ type: 'aborted' });
      return;
    }
    const ownsCancellation = () =>
      this.generation === cancellationGeneration && this.sessionMatches(session);
    try {
      let status = await this.api.getStatus(session.videoId, session.uploadId);
      if (!ownsCancellation()) return;
      try {
        const result = await this.api.abort(session.videoId, session.uploadId, status.revision);
        if (!ownsCancellation()) return;
        this.applyAbortStatus(result);
      } catch (error) {
        if (!(error instanceof UploadApiError) || error.code !== 'STALE_REVISION') throw error;
        status = await this.api.getStatus(session.videoId, session.uploadId);
        if (!ownsCancellation()) return;
        if (['active', 'completing', 'failed'].includes(status.state)) {
          const result = await this.api.abort(session.videoId, session.uploadId, status.revision);
          if (!ownsCancellation()) return;
          this.applyAbortStatus(result);
        } else {
          this.applyAbortStatus(status);
        }
      }
    } catch (error) {
      if (!ownsCancellation()) return;
      if (error instanceof UploadApiError && error.code === 'PROVIDER_CLEANUP_REQUIRED') {
        this.dispatchAction({ type: 'cleanup_pending', message: error.message });
      } else {
        this.handleFailure(error);
      }
    }
  }

  dispose() {
    this.stopLocalWork();
  }

  private applyAbortStatus(status: UploadStatusResponse) {
    if (status.state === 'aborted') {
      this.sessions.clear();
      this.session = null;
      this.dispatchAction({ type: 'aborted' });
      return;
    }
    if (status.state === 'abort_pending') {
      this.dispatchAction({
        type: 'cleanup_pending',
        message: 'Provider cleanup is still pending; the upload was not fully aborted.',
      });
      return;
    }
    if (status.state === 'expired') {
      this.handleFailure(
        new UploadApiError('UPLOAD_EXPIRED', 409, 'The upload expired before it could be aborted.'),
      );
      return;
    }
    this.handleFailure(
      new UploadApiError(
        'INVALID_UPLOAD_STATE',
        409,
        `The upload cannot be aborted from its authoritative state: ${status.state}`,
      ),
    );
  }

  private async cleanupLateCreatedUpload(videoId: string, uploadId: string) {
    try {
      let status = await this.api.getStatus(videoId, uploadId);
      if (status.state === 'aborted' || status.state === 'expired' || status.state === 'completed')
        return;
      try {
        const result = await this.api.abort(videoId, uploadId, status.revision);
        if (result.state === 'abort_pending') return;
      } catch (error) {
        if (!(error instanceof UploadApiError) || error.code !== 'STALE_REVISION') return;
        status = await this.api.getStatus(videoId, uploadId);
        if (['active', 'completing', 'failed'].includes(status.state))
          await this.api.abort(videoId, uploadId, status.revision);
      }
    } catch {
      // Never attach a late-created upload to a newer local generation.
    }
  }

  private async run(file: File, status: UploadStatusResponse) {
    const runGeneration = this.generation;
    if (this.runningGeneration !== null) return;
    this.runningGeneration = runGeneration;
    this.fatal = false;
    const missing = Object.values(this.state.parts)
      .filter((part) => part.phase !== 'recorded')
      .map((part) => part.partNumber);
    if (missing.length === 0) {
      if (this.runningGeneration === runGeneration) this.runningGeneration = null;
      await this.complete(status, runGeneration);
      return;
    }
    const concurrency = Math.max(
      1,
      Math.min(this.policy.maxConcurrency, status.maxConcurrency, missing.length),
    );
    let nextIndex = 0;
    const signer = this.createSigner(status, runGeneration);
    const worker = async () => {
      while (nextIndex < missing.length && !this.fatal && !this.isCancelled(runGeneration)) {
        const partNumber = missing[nextIndex++];
        if (partNumber === undefined) return;
        await this.processPart(file, status, partNumber, signer, runGeneration);
      }
    };
    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (!this.isCancelled(runGeneration) && !this.fatal) await this.complete(status, runGeneration);
    } catch (error) {
      if (!(error instanceof CancelledError) && this.isCurrentGeneration(runGeneration))
        this.handleFailure(error);
    } finally {
      signer.clear();
      if (this.runningGeneration === runGeneration) this.runningGeneration = null;
    }
  }

  private async complete(status: UploadStatusResponse, runGeneration: number) {
    this.dispatchAction({ type: 'all_parts_recorded' });
    if (this.isCancelled(runGeneration)) return;
    this.dispatchAction({ type: 'completing' });
    const result = await this.api.complete(status.videoId, status.uploadId, status.revision);
    this.assertCurrent(runGeneration);
    if (result.outcome === 'ready') {
      this.sessions.clear();
      this.session = null;
      this.dispatchAction({ type: 'ready' });
    }
  }

  private createSigner(status: UploadStatusResponse, runGeneration: number) {
    const urls = new Map<number, { url: string; expiresAt: number }>();
    const queued = new Map<
      number,
      Array<{ resolve: (url: string) => void; reject: (error: Error) => void }>
    >();
    let scheduled = false;
    const flush = async () => {
      scheduled = false;
      if (this.isCancelled(runGeneration)) return;
      const numbers = [...queued.keys()].slice(0, this.policy.signingWindow);
      if (numbers.length === 0) return;
      try {
        const response: PartUrlResponse = await this.api.signParts(
          status.videoId,
          status.uploadId,
          {
            partNumbers: numbers,
          },
        );
        const returned = new Map(response.parts.map((part) => [part.partNumber, part]));
        for (const number of numbers) {
          const waiters = queued.get(number) ?? [];
          queued.delete(number);
          const part = returned.get(number);
          if (!part)
            waiters.forEach(({ reject }) =>
              reject(new Error('Signing response omitted a requested part')),
            );
          else {
            urls.set(number, { url: part.url, expiresAt: Date.parse(part.expiresAt) });
            waiters.forEach(({ resolve }) => resolve(part.url));
          }
        }
      } catch (error) {
        for (const number of numbers) {
          const waiters = queued.get(number) ?? [];
          queued.delete(number);
          waiters.forEach(({ reject }) =>
            reject(error instanceof Error ? error : new Error('Signing failed')),
          );
        }
      }
      if (queued.size > 0) void flush();
    };
    const get = (partNumber: number, forceRefresh = false): Promise<string> => {
      const cached = urls.get(partNumber);
      if (!forceRefresh && cached && cached.expiresAt - Date.now() > this.policy.presignedUrlSkewMs)
        return Promise.resolve(cached.url);
      urls.delete(partNumber);
      return new Promise((resolve, reject) => {
        const waiters = queued.get(partNumber) ?? [];
        waiters.push({ resolve, reject });
        queued.set(partNumber, waiters);
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(() => void flush());
        }
      });
    };
    return {
      get,
      clear: () => {
        urls.clear();
        for (const waiters of queued.values())
          waiters.forEach(({ reject }) => reject(new CancelledError()));
        queued.clear();
      },
    };
  }

  private async processPart(
    file: File,
    status: UploadStatusResponse,
    partNumber: number,
    signer: { get: (partNumber: number, forceRefresh?: boolean) => Promise<string> },
    runGeneration: number,
  ) {
    const range = calculatePartRange(
      file.size,
      status.partSizeBytes,
      status.expectedPartCount,
      partNumber,
    );
    let expiredRefreshUsed = false;
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      if (this.isCancelled(runGeneration)) throw new CancelledError();
      this.dispatchAction({ type: 'part_started', partNumber, sizeBytes: range.size, attempt });
      try {
        let url = await signer.get(partNumber);
        this.assertCurrent(runGeneration);
        let put: { etag: string };
        this.assertCurrent(runGeneration);
        const body = file.slice(range.start, range.end);
        this.assertCurrent(runGeneration);
        try {
          put = await this.putPart(body, url, partNumber, attempt, runGeneration);
        } catch (error) {
          if (!expiredRefreshUsed && isLikelyExpired(error)) {
            expiredRefreshUsed = true;
            url = await signer.get(partNumber, true);
            this.assertCurrent(runGeneration);
            put = await this.putPart(body, url, partNumber, attempt, runGeneration);
          } else throw error;
        }
        if (this.isCancelled(runGeneration)) throw new CancelledError();
        this.dispatchAction({ type: 'part_recording', partNumber, attempt });
        await this.api.recordPart(status.videoId, status.uploadId, partNumber, {
          etag: put.etag,
          reportedSizeBytes: range.size,
        });
        this.assertCurrent(runGeneration);
        const currentPart = this.state.parts[partNumber];
        if (!currentPart || currentPart.attempt !== attempt || currentPart.phase !== 'recording')
          throw new CancelledError();
        this.dispatchAction({ type: 'part_recorded', partNumber, sizeBytes: range.size, attempt });
        return;
      } catch (error) {
        if (this.isCancelled(runGeneration)) throw new CancelledError();
        if (!retryable(error) || attempt >= this.policy.maxAttempts) throw error;
        const delayMs = this.backoff(attempt);
        this.dispatchAction({ type: 'retry_wait', partNumber, attempt: attempt + 1, delayMs });
        await this.wait(delayMs, runGeneration);
      }
    }
  }

  private putPart(
    body: Blob,
    url: string,
    partNumber: number,
    attempt: number,
    runGeneration: number,
  ) {
    const controller = new AbortController();
    this.controllers.add(controller);
    return this.transport({
      url,
      body,
      signal: controller.signal,
      inactivityTimeoutMs: this.policy.inactivityTimeoutMs,
      onProgress: (loadedBytes) => {
        if (!this.isCancelled(runGeneration))
          this.dispatchAction({ type: 'part_progress', partNumber, attempt, loadedBytes });
      },
    }).finally(() => this.controllers.delete(controller));
  }

  private wait(delayMs: number, runGeneration: number) {
    if (this.isCancelled(runGeneration)) return Promise.reject(new CancelledError());
    return new Promise<void>((resolve, reject) => {
      const waiter: TimerWaiter = {
        timer: setTimeout(() => {
          this.timers.delete(waiter);
          resolve();
        }, delayMs),
        reject,
      };
      this.timers.add(waiter);
    });
  }

  private backoff(attempt: number) {
    const exponential = Math.min(
      this.policy.retryMaxDelayMs,
      this.policy.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1),
    );
    return Math.floor(Math.random() * exponential);
  }

  private isCancelled(runGeneration: number) {
    return this.paused || this.generation !== runGeneration;
  }

  private isCurrentGeneration(operationGeneration: number) {
    return this.generation === operationGeneration && !this.paused;
  }

  private sessionMatches(session: StoredUploadSession) {
    const current = this.session ?? this.sessions.load();
    return current?.videoId === session.videoId && current.uploadId === session.uploadId;
  }

  private assertCurrent(runGeneration: number) {
    if (this.isCancelled(runGeneration)) throw new CancelledError();
  }

  private stopLocalWork() {
    this.generation += 1;
    this.paused = true;
    this.runningGeneration = null;
    this.abortActiveRequests();
    this.rejectTimers();
  }

  private abortActiveRequests() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private rejectTimers() {
    const error = new CancelledError();
    for (const waiter of this.timers) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.timers.clear();
  }

  private handleFailure(error: unknown, forcedCategory?: string) {
    if (error instanceof CancelledError) return;
    this.fatal = true;
    this.abortActiveRequests();
    const category = forcedCategory ?? errorCategory(error);
    this.dispatchAction({
      type: 'failed',
      category,
      message: messageFor(error),
      requestId: error instanceof UploadApiError ? error.requestId : undefined,
    });
  }
}
