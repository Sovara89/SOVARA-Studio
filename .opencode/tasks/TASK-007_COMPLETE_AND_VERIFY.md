# TASK-007 — COMPLETE MULTIPART + SERVER VERIFICATION

Implement secure completion.

Backend:

- validates ownership/session;
- completes multipart with correct partNumber + ETag list;
- performs final S3 HEAD/metadata verification;
- verifies existence and expected size;
- validates relevant metadata/type;
- only then marks source READY;
- repeated complete should be safe/idempotent where feasible.

Never trust arbitrary client object key or `uploaded=true`.
