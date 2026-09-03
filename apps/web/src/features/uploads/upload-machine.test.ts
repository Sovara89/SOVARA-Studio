import { describe, expect, test } from 'vitest';
import { initialUploadMachineState, uploadMachineReducer } from './upload-machine';

describe('uploadMachineReducer', () => {
  test('moves a part to confirmed only after record acknowledgement', () => {
    const base = uploadMachineReducer(initialUploadMachineState, {
      type: 'creating',
      file: new File(['12345'], 'source.mp4'),
    });
    const started = uploadMachineReducer(base, {
      type: 'session_created',
      videoId: 'v',
      uploadId: 'u',
      status: {
        videoId: 'v',
        uploadId: 'u',
        state: 'active',
        expectedSizeBytes: 5,
        partSizeBytes: 5,
        expectedPartCount: 1,
        expiresAt: new Date().toISOString(),
        revision: 0,
        maxConcurrency: 1,
        parts: [],
      },
      parts: { 1: { partNumber: 1, sizeBytes: 5, phase: 'pending', loadedBytes: 0, attempt: 0 } },
      confirmedBytes: 0,
    });
    const progress = uploadMachineReducer(started, {
      type: 'part_started',
      partNumber: 1,
      sizeBytes: 5,
      attempt: 1,
    });
    expect(
      uploadMachineReducer(progress, {
        type: 'part_progress',
        partNumber: 1,
        attempt: 1,
        loadedBytes: 5,
      }).confirmedBytes,
    ).toBe(0);
    const recorded = uploadMachineReducer(progress, {
      type: 'part_recorded',
      partNumber: 1,
      sizeBytes: 5,
      attempt: 1,
    });
    expect(recorded.phase).toBe('all_parts_recorded');
    expect(recorded.confirmedBytes).toBe(5);
    const stale = uploadMachineReducer(recorded, {
      type: 'part_progress',
      partNumber: 1,
      attempt: 99,
      loadedBytes: 0,
    });
    expect(stale).toEqual(recorded);
  });
});
