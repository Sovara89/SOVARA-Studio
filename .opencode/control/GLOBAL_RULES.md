# SOVARA Studio — GREENFIELD GLOBAL RULES

SOVARA Studio is a NEW standalone product being created in this workspace.

## Hard boundary

The ONLY allowed project is the current workspace containing `.sovara-studio-root`.

Before every stage:

1. Check `.sovara-studio-root`.
2. Run `pwd`.
3. If the active path is not SOVARA Studio, STOP.
4. If the active path contains/resolves to `SOVARA Widgets`, STOP.
5. Git is OPTIONAL.
6. If Git exists, report its root/status.
7. If Git does not exist, report `GIT MODE: NOT AVAILABLE` and continue.
8. Never initialize Git automatically unless a human explicitly asks.
9. Never read/write/copy implementation from `SOVARA Widgets` unless a human explicitly authorizes it.

## Greenfield rule

An empty application workspace is EXPECTED.

Do not block because frontend/backend/ORM/auth do not exist yet.

TASK-001 exists to DESIGN the initial architecture.
TASK-002 exists to CREATE the approved skeleton.

Do not invent application code before TASK-001 is approved.

## Human gate

Exactly ONE task at a time.

Required lifecycle:

PLAN -> HUMAN APPROVAL -> BUILD -> REVIEW -> VERIFY -> HUMAN APPROVAL -> NEXT TASK

Never proceed to the next stage or task automatically.

## Scope safety

- Do not create unrelated services.
- Do not add a technology just because it is familiar.
- Prefer a small coherent stack over microservice sprawl.
- Do not duplicate concerns across apps.
- Do not build a second auth/storage/queue system later if one already exists in Studio.
- Do not modify unrelated user files.

## Git safety

If Git exists:

- no commit/push;
- no destructive reset/clean/restore;
- preserve unrelated local changes.

## Truthful reporting

Never claim PASS unless the exact command ran and succeeded.
Never hide:

- TODO;
- mock/stub;
- blocked external OAuth;
- missing credentials;
- skipped tests;
- missing DB/queue/S3;
- fake implementations.

## Large-video invariants

These are architectural invariants for the whole project:

- Browser uploads source video directly to PRIVATE S3-compatible storage.
- Backend must not proxy large source-video bytes.
- Use Multipart Upload for large files.
- Part size and concurrency are configurable.
- ETag/part completion flow must be coherent end-to-end.
- Backend verifies completed object before READY.
- Workers never buffer the entire large video into RAM.
- YouTube and VK publications are independent jobs.
- Retry and idempotency are designed explicitly.
