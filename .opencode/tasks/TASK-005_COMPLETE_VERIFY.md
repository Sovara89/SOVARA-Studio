# TASK-005 — MULTIPART COMPLETE + SERVER VERIFICATION

Backend is the source of truth.

On complete:

- verify ownership and expected session;
- accept/derive the real part-number + ETag list safely;
- CompleteMultipartUpload;
- perform final S3 HEAD/metadata verification;
- verify object exists and expected size;
- validate relevant metadata/content type;
- only then mark source READY;
- make repeated complete calls safe/idempotent where feasible.

Never accept an arbitrary object key or a frontend "uploaded=true" as proof.
