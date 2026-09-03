function safeIdentifier(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(normalized) ? normalized : fallback;
}

/**
 * Produces operational error fields which are safe to serialize. Error messages, causes,
 * stacks, URLs and provider response bodies are intentionally excluded because they may carry
 * credentials or resumable upload URLs.
 */
export function safeErrorFields(error: unknown) {
  const record = typeof error === 'object' && error !== null ? error : undefined;
  const name = record && 'name' in record ? record.name : undefined;
  const code = record && 'code' in record ? record.code : undefined;
  return {
    errorName: safeIdentifier(name, error instanceof Error ? 'Error' : 'UnknownError'),
    errorCode: safeIdentifier(code, 'UNKNOWN'),
  };
}
