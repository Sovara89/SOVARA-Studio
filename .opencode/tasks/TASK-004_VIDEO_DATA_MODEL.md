# TASK-004 — VIDEO / UPLOAD / PUBLICATION DATA MODEL

Add production data model for:

- video/source;
- multipart upload session if needed;
- per-platform publication.

Requirements:

- user ownership;
- source object key/size/type/status;
- upload lifecycle state;
- publication uniqueness per video/platform;
- progress;
- safe error fields;
- external video id/url;
- attempts/timestamps;
- useful indexes/constraints.

Use existing Studio auth/ORM conventions from TASK-003.
