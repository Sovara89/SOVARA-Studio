# TASK-006 — FRONTEND MULTIPART UPLOADER

Implement Studio UI/client upload flow.

Requirements:

- file selection/drop;
- chunking using configured part size;
- bounded parallel part uploads;
- retry failed part;
- capture every ETag;
- overall progress;
- speed/ETA if practical;
- no whole-file buffering;
- no upload through backend;
- preserve session data needed for completion/recovery.

ETag flow must connect to backend completion.
