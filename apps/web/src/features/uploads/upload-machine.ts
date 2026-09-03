import type { UploadStatusResponse } from '@sovara-studio/contracts';

export type UploadPhase =
  | 'idle'
  | 'creating'
  | 'uploading'
  | 'paused'
  | 'retry_wait'
  | 'all_parts_recorded'
  | 'aborting'
  | 'cleanup_pending'
  | 'aborted'
  | 'failed';

export type PartView = {
  partNumber: number;
  sizeBytes: number;
  phase: 'pending' | 'signing' | 'uploading' | 'recording' | 'recorded' | 'retry_wait' | 'failed';
  loadedBytes: number;
  attempt: number;
};

export type UploadMachineState = {
  phase: UploadPhase;
  file?: File;
  videoId?: string;
  uploadId?: string;
  status?: UploadStatusResponse;
  parts: Record<number, PartView>;
  confirmedBytes: number;
  inFlightBytes: Record<number, number>;
  retryPartNumber?: number;
  retryAttempt?: number;
  retryDelayMs?: number;
  error?: { category: string; message: string; requestId?: string };
};

export const initialUploadMachineState: UploadMachineState = {
  phase: 'idle',
  parts: {},
  confirmedBytes: 0,
  inFlightBytes: {},
};

export type UploadMachineAction =
  | { type: 'creating'; file: File }
  | {
      type: 'session_created';
      videoId: string;
      uploadId: string;
      status: UploadStatusResponse;
      parts: Record<number, PartView>;
      confirmedBytes: number;
    }
  | {
      type: 'status_loaded';
      status: UploadStatusResponse;
      parts: Record<number, PartView>;
      confirmedBytes: number;
    }
  | { type: 'uploading' }
  | { type: 'part_started'; partNumber: number; sizeBytes: number; attempt: number }
  | { type: 'part_progress'; partNumber: number; attempt: number; loadedBytes: number }
  | { type: 'part_recording'; partNumber: number; attempt: number }
  | { type: 'part_recorded'; partNumber: number; sizeBytes: number; attempt: number }
  | { type: 'all_parts_recorded' }
  | { type: 'retry_wait'; partNumber: number; attempt: number; delayMs: number }
  | { type: 'paused' }
  | { type: 'aborting' }
  | { type: 'cleanup_pending'; message: string }
  | { type: 'aborted' }
  | { type: 'failed'; category: string; message: string; requestId?: string }
  | { type: 'reset' };

export function uploadMachineReducer(
  state: UploadMachineState,
  action: UploadMachineAction,
): UploadMachineState {
  switch (action.type) {
    case 'creating':
      return { ...initialUploadMachineState, phase: 'creating', file: action.file };
    case 'session_created':
      return {
        ...state,
        phase: 'uploading',
        videoId: action.videoId,
        uploadId: action.uploadId,
        status: action.status,
        parts: action.parts,
        confirmedBytes: action.confirmedBytes,
        error: undefined,
      };
    case 'status_loaded':
      return {
        ...state,
        phase: 'uploading',
        status: action.status,
        parts: action.parts,
        confirmedBytes: action.confirmedBytes,
        error: undefined,
      };
    case 'uploading':
      return { ...state, phase: 'uploading', error: undefined };
    case 'part_started':
      return {
        ...state,
        parts: {
          ...state.parts,
          [action.partNumber]: {
            ...state.parts[action.partNumber]!,
            phase: 'uploading',
            loadedBytes: 0,
            attempt: action.attempt,
          },
        },
        inFlightBytes: { ...state.inFlightBytes, [action.partNumber]: 0 },
      };
    case 'part_progress': {
      const part = state.parts[action.partNumber];
      if (!part || part.attempt !== action.attempt || part.phase === 'recorded') return state;
      return {
        ...state,
        parts: {
          ...state.parts,
          [action.partNumber]: { ...part, phase: 'uploading', loadedBytes: action.loadedBytes },
        },
        inFlightBytes: { ...state.inFlightBytes, [action.partNumber]: action.loadedBytes },
      };
    }
    case 'part_recording': {
      const part = state.parts[action.partNumber];
      if (!part || part.attempt !== action.attempt) return state;
      return {
        ...state,
        parts: { ...state.parts, [action.partNumber]: { ...part, phase: 'recording' } },
      };
    }
    case 'part_recorded': {
      const part = state.parts[action.partNumber];
      if (!part || part.attempt !== action.attempt || part.phase === 'recorded') return state;
      const recordedPart: PartView = { ...part, phase: 'recorded', loadedBytes: action.sizeBytes };
      const parts: Record<number, PartView> = { ...state.parts, [action.partNumber]: recordedPart };
      const inFlightBytes = { ...state.inFlightBytes };
      delete inFlightBytes[action.partNumber];
      const confirmedBytes = state.confirmedBytes + action.sizeBytes;
      const complete = Object.values(parts).every((item) => item.phase === 'recorded');
      return {
        ...state,
        phase: complete ? 'all_parts_recorded' : 'uploading',
        parts,
        inFlightBytes,
        confirmedBytes,
        error: undefined,
      };
    }
    case 'all_parts_recorded':
      return { ...state, phase: 'all_parts_recorded', inFlightBytes: {} };
    case 'retry_wait': {
      const part = state.parts[action.partNumber];
      if (!part) return state;
      return {
        ...state,
        phase: 'retry_wait',
        retryPartNumber: action.partNumber,
        retryAttempt: action.attempt,
        retryDelayMs: action.delayMs,
        parts: {
          ...state.parts,
          [action.partNumber]: {
            ...part,
            phase: 'retry_wait',
            loadedBytes: 0,
            attempt: action.attempt,
          },
        },
        inFlightBytes: { ...state.inFlightBytes, [action.partNumber]: 0 },
      };
    }
    case 'paused':
      return {
        ...state,
        phase: 'paused',
        retryPartNumber: undefined,
        retryAttempt: undefined,
        retryDelayMs: undefined,
      };
    case 'aborting':
      return { ...state, phase: 'aborting' };
    case 'cleanup_pending':
      return {
        ...state,
        phase: 'cleanup_pending',
        error: { category: 'provider_cleanup_pending', message: action.message },
      };
    case 'aborted':
      return { ...state, phase: 'aborted', error: undefined };
    case 'failed':
      return {
        ...state,
        phase: 'failed',
        error: { category: action.category, message: action.message, requestId: action.requestId },
      };
    case 'reset':
      return initialUploadMachineState;
  }
}
