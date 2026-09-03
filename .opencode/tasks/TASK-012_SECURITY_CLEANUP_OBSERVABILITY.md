# TASK-012 — SECURITY / CLEANUP / OBSERVABILITY

Security:

- ownership checks;
- private source bucket;
- no secrets on frontend/logs;
- secure token storage according to existing project mechanisms;
- no arbitrary client-controlled S3 keys;
- safe user-facing errors.

Cleanup:

- incomplete multipart uploads;
- temporary worker files if any;
- queue retention/DLQ according to chosen queue;
- S3 AbortIncompleteMultipartUpload lifecycle documentation/config where appropriate.

Observability:

- useful structured identifiers (videoId/publicationId/platform/attempt);
- no token/presigned URL leakage.
