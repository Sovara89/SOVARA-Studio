# TASK-005 — PRIVATE S3 MULTIPART BACKEND

Implement backend control plane for direct browser multipart upload.

Requirements:

- private S3-compatible bucket;
- server-generated object key;
- create multipart upload;
- presign required parts;
- configurable part size and presign TTL;
- configurable max upload size;
- MIME/extension validation;
- ownership checks;
- no AWS credentials in frontend;
- backend never receives the large video body.

Do not hardcode 10 GB unless product requirements explicitly choose that limit.
