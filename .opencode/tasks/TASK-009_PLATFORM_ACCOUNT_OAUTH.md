# TASK-009 — PLATFORM ACCOUNT / OAUTH LIFECYCLE

Implement actual account connection lifecycle for YouTube and VK as supported by their APIs.

Requirements:

- auth start/callback where applicable;
- CSRF/state protection;
- credential persistence;
- refresh lifecycle;
- refreshed token is persisted and used immediately;
- disconnect/reconnect behavior;
- ownership;
- safe secret handling;
- no access/refresh token logging.

Do not report OAuth complete unless the real callback/token lifecycle exists.
