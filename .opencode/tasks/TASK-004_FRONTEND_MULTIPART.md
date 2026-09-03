# TASK-004 — FRONTEND MULTIPART UPLOADER

Integrate into existing SOVARA Studio UI.

Requirements:

- split file into configurable multipart chunks;
- parallel upload with bounded concurrency;
- retry individual failed parts;
- capture ETag for every successful part;
- overall progress;
- reasonable speed/ETA if existing UI supports it;
- no full-file buffering in RAM;
- no video upload through backend;
- preserve upload session information required for completion/recovery.

The frontend/backend ETag flow must be complete end-to-end.
