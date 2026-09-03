import { describe, expect, test } from 'vitest';
import { computeResumeFingerprint } from './file-resume-fingerprint';

describe('computeResumeFingerprint', () => {
  test('matches identical sampled regions and distinguishes sampled-region changes', async () => {
    const first = new File(['beginning', 'middle', 'end'], 'one.mp4', { type: 'video/mp4' });
    const same = new File(['beginning', 'middle', 'end'], 'copy.mp4', { type: 'video/mp4' });
    const different = new File(['beginning', 'changed', 'end'], 'other.mp4', { type: 'video/mp4' });
    await expect(computeResumeFingerprint(first, { sampleSizeBytes: 4 })).resolves.toBe(
      await computeResumeFingerprint(same, { sampleSizeBytes: 4 }),
    );
    await expect(computeResumeFingerprint(first, { sampleSizeBytes: 4 })).resolves.not.toBe(
      await computeResumeFingerprint(different, { sampleSizeBytes: 4 }),
    );
  });

  test('uses only bounded slices for a logical large file', async () => {
    const ranges: Array<[number, number]> = [];
    const file = {
      size: 50 * 1024 ** 3,
      slice(start: number, end: number) {
        ranges.push([start, end]);
        return new Blob([new Uint8Array(end - start > 1024 * 1024 ? 1024 * 1024 : end - start)]);
      },
    } as unknown as Blob;
    await computeResumeFingerprint(file);
    expect(ranges).toHaveLength(3);
    expect(ranges.every(([start, end]) => end - start <= 1024 * 1024)).toBe(true);
  });
});
