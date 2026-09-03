import { UploadError } from '../upload-errors.js';

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 64 * 1024;

type SafeParseSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
};

export function parseJsonBody<T>(
  body: unknown,
  schema: SafeParseSchema<T>,
  maxBytes = DEFAULT_JSON_BODY_LIMIT_BYTES,
) {
  let value: unknown;
  if (Buffer.isBuffer(body)) {
    if (body.byteLength > maxBytes)
      throw new UploadError('INVALID_REQUEST', 'Request body is too large');
    try {
      value = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new UploadError('INVALID_REQUEST', 'Request body must be valid JSON');
    }
  } else if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > maxBytes)
      throw new UploadError('INVALID_REQUEST', 'Request body is too large');
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new UploadError('INVALID_REQUEST', 'Request body must be valid JSON');
    }
  } else {
    throw new UploadError('INVALID_REQUEST', 'Request body must be JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new UploadError('INVALID_REQUEST', 'Request body failed validation', {
      cause: parsed.error,
    });
  return parsed.data;
}
