# TASK-003 — PRIVATE S3 MULTIPART BACKEND

Implement backend control plane for large-file direct upload.

Requirements:

- Browser uploads video directly to private S3.
- Backend never proxies video bytes.
- Create multipart upload session.
- Presign only required parts.
- Secure object key generated server-side.
- Validate ownership, MIME/extension and configured max size.
- Configurable part size, concurrency guidance and presigned TTL.
- No AWS credentials on frontend.
- No public source object.

Do not hardcode a 10 GB limit unless product config explicitly requires it.
