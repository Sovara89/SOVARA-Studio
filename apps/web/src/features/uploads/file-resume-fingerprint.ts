export const RESUME_FINGERPRINT_VERSION = 1;
export const DEFAULT_FINGERPRINT_SAMPLE_SIZE_BYTES = 1024 * 1024;

type FingerprintOptions = {
  sampleSizeBytes?: number;
  subtle?: SubtleCrypto;
};

function sampleRanges(size: number, sampleSize: number) {
  const boundedSample = Math.min(sampleSize, size);
  return [
    { label: 'beginning', start: 0, end: boundedSample },
    {
      label: 'middle',
      start: Math.max(0, Math.floor((size - boundedSample) / 2)),
      end: Math.max(0, Math.floor((size - boundedSample) / 2)) + boundedSample,
    },
    { label: 'end', start: Math.max(0, size - boundedSample), end: size },
  ];
}

function append(target: Uint8Array[], value: Uint8Array) {
  target.push(value);
}

export async function computeResumeFingerprint(file: Blob, options: FingerprintOptions = {}) {
  if (!Number.isSafeInteger(file.size) || file.size < 0)
    throw new Error('File size is not a safe integer');
  const sampleSize = options.sampleSizeBytes ?? DEFAULT_FINGERPRINT_SAMPLE_SIZE_BYTES;
  if (!Number.isSafeInteger(sampleSize) || sampleSize <= 0)
    throw new Error('Fingerprint sample size is invalid');
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  append(
    chunks,
    encoder.encode(`sovara-resume-v${RESUME_FINGERPRINT_VERSION}\0size:${file.size}\0`),
  );
  for (const range of sampleRanges(file.size, sampleSize)) {
    const bytes = new Uint8Array(await file.slice(range.start, range.end).arrayBuffer());
    append(
      chunks,
      encoder.encode(`${range.label}\0${range.start}:${range.end}\0${bytes.byteLength}\0`),
    );
    append(chunks, bytes);
  }
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const material = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    material.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const subtle = options.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is unavailable');
  const digest = new Uint8Array(await subtle.digest('SHA-256', material));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
