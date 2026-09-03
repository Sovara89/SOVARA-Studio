# SOVARA Studio reliability and security contract

## Publication retries

BullMQ delivery retries and provider retries are separate mechanisms. BullMQ retries unexpected
processor failures using `PUBLICATION_JOB_ATTEMPTS` and exponential
`PUBLICATION_JOB_BACKOFF_MS`. A definite provider failure is settled in PostgreSQL and never
relies on BullMQ retry state.

Retryable provider failures use deterministic exponential delay:

`min(maxDelay, max(baseDelay * 2^(cycleAttempt-1) + deterministicJitter, boundedRetryAfter))`

Jitter is 0–20 percent and is derived from the immutable attempt ID. Automatic retries stop at
`PUBLICATION_MAX_PROVIDER_ATTEMPTS` or `PUBLICATION_RETRY_WINDOW_MS`. Provider Retry-After is
capped by `PUBLICATION_MAX_PROVIDER_RETRY_AFTER_MS` and the maximum delay.

An authenticated explicit retry may transition only the owner's `failed` publication at the
submitted revision back to `queued`. It starts a new retry cycle while retaining the total attempt
count and every prior attempt row. Parallel requests are revision-CAS protected.

## Crash window and reconciliation

The worker records `request_sent` before provider dispatch. Any exception or lease expiry after
that boundary is ambiguous and enters reconciliation; it must not start another blind provider
request. Provider evidence is immutable/CAS checkpointed. An unresolved result is retried only by
reconciliation until the configured maximum age, after which manual review is required.

## Multipart cleanup

The API cleanup loop recovers uncertain initiations and claims expired uploads through PostgreSQL
revision CAS before calling the existing multipart cleanup path. That path preserves completion
reconciliation: a missing multipart upload after Complete may represent a completed object and is
verified before an upload is marked expired. `abort_pending` claims can be recovered after
`UPLOAD_CLEANUP_CLAIM_TIMEOUT_MS`. Provider lifecycle expiration remains a mandatory backstop.

No source-video temporary files are used. Publishers consume range or streaming S3 reads and must
not buffer the complete source object in memory.

## Security

- Source and preview objects are private; clients receive only scoped presigned operations.
- Source object keys are generated server-side and are absent from client request contracts.
- All user-facing mutation paths use authenticated owner IDs and revision CAS.
- OAuth credentials are AES-256-GCM envelopes bound to account, platform and credential kind.
- Operational error logging excludes messages, causes, stacks, provider bodies, tokens and URLs.
- User-facing publication errors are controlled messages rather than persisted provider text.

Integration infrastructure is required. Missing PostgreSQL, Redis, MinIO or required environment
must fail or be reported BLOCKED; tests must not silently return green.
