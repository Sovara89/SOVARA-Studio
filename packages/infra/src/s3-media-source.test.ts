import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { createS3MediaSource } from './s3-media-source.js';

function setup() {
  const send = vi.fn().mockResolvedValue({ Body: Readable.from([Buffer.from('video')]) });
  const source = createS3MediaSource({
    client: { send } as never,
    bucket: 'private-video-source',
    objectKey: 'videos/owner/video.mp4',
    sizeBytes: 100,
    contentType: 'video/mp4',
    versionId: 'version-1',
    expectedEtag: '"etag-1"',
  });
  return { send, source };
}

describe('S3 media source', () => {
  test('is lazy and opens a bounded-backpressure Node stream', async () => {
    const { send, source } = setup();
    expect(send).not.toHaveBeenCalled();
    const stream = await source.openReadStream();
    expect(stream).toBeInstanceOf(Readable);
    expect(send).toHaveBeenCalledOnce();
    const input = send.mock.calls[0]![0].input;
    expect(input).toMatchObject({
      Bucket: 'private-video-source',
      Key: 'videos/owner/video.mp4',
      VersionId: 'version-1',
      IfMatch: '"etag-1"',
    });
    expect(input.Range).toBeUndefined();
  });

  test('converts half-open ranges to S3 inclusive ranges', async () => {
    const { send, source } = setup();
    await source.openReadStream({ start: 10, endExclusive: 25 });
    expect(send.mock.calls[0]![0].input.Range).toBe('bytes=10-24');
  });

  test('validates ranges without issuing a request', async () => {
    const { send, source } = setup();
    await expect(source.openReadStream({ start: 25, endExclusive: 25 })).rejects.toThrow(/range/i);
    await expect(source.openReadStream({ start: 0, endExclusive: 101 })).rejects.toThrow(/range/i);
    expect(send).not.toHaveBeenCalled();
  });

  test('passes abort signals to GetObject', async () => {
    const { send, source } = setup();
    const controller = new AbortController();
    await source.openReadStream({ signal: controller.signal });
    expect(send.mock.calls[0]![1]).toEqual({ abortSignal: controller.signal });
  });

  test('opens independent streams for repeated reads', async () => {
    const { send, source } = setup();
    await source.openReadStream({ start: 0, endExclusive: 10 });
    await source.openReadStream({ start: 0, endExclusive: 10 });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
