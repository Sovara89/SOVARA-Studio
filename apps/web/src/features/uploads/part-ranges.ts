export type PartRange = { partNumber: number; start: number; end: number; size: number };

function assertSafePositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a safe integer`);
}

export function calculatePartRange(
  fileSizeBytes: number,
  partSizeBytes: number,
  expectedPartCount: number,
  partNumber: number,
): PartRange {
  assertSafePositiveInteger(fileSizeBytes, 'File size');
  assertSafePositiveInteger(partSizeBytes, 'Part size');
  assertSafePositiveInteger(expectedPartCount, 'Part count');
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > expectedPartCount)
    throw new Error('Part number is outside the upload range');
  const start = (partNumber - 1) * partSizeBytes;
  const end = Math.min(start + partSizeBytes, fileSizeBytes);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start)
    throw new Error('Part range is invalid');
  const size = end - start;
  if (!Number.isSafeInteger(size)) throw new Error('Part size is unsafe');
  return { partNumber, start, end, size };
}

export function validatePartPlan(
  fileSizeBytes: number,
  partSizeBytes: number,
  expectedPartCount: number,
) {
  const finalPart = calculatePartRange(
    fileSizeBytes,
    partSizeBytes,
    expectedPartCount,
    expectedPartCount,
  );
  if (finalPart.end !== fileSizeBytes) throw new Error('File size does not match the server plan');
  return finalPart;
}
