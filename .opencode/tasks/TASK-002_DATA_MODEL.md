# TASK-002 — VIDEO / UPLOAD / PUBLICATION DATA MODEL

Implement only after approved TASK-001 plan.

Add/adapt data model for:

- video/source object;
- multipart upload session if needed by existing architecture;
- publication per platform.

Requirements:

- real user ownership;
- publication uniqueness for `(video, platform)` or equivalent;
- states for uploading/ready/publishing/completed/failed;
- progress and safe error storage;
- external video id/url;
- timestamps and useful indexes;
- use existing ORM/migration conventions.

Do not create a second user/auth model.
