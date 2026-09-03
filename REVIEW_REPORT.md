# TASK-013 Final Verification Evidence

- Date: 2026-09-02
- Workspace guard: `.sovara-studio-root` was present; working directory was `E:\AI\SOVARA Studio`; no SOVARA Widgets content was accessed.
- Git mode: not available.
- Scope: test and evidence source only. No production source, package manifest, lockfile, or package artifact was changed.

## Source and coverage state

- Added `tests/integration/task-013-publication-draft.integration.test.ts`.
- Updated this report only.
- The new test uses an isolated migrated PostgreSQL database, production Fastify registration/routes/auth/service/repository code, and MinIO through the production private-preview storage implementation. It covers:
  - READY video + VK draft + real direct presigned preview upload + completion + API removal;
  - PostgreSQL preview-column unlink, deleted private ready object, and API reload with `preview: null`;
  - deterministic preview-storage delete failure retaining the authoritative saved unlink;
  - the exact default `https://vk.com/sovara_news` persisted through `GET /api/publication-intents` after creation, replacement persisted through the same GET after update, and intentional clear save/reload with an asserted HTTP 200 reload response;
  - zero `publication` and `publication_attempt` records for these draft-only flows.
- No publication path, worker, or publisher is constructed by this test. The test directly proves no database publication/attempt state. It does not independently intercept outbound HTTP, so it does not independently observe the absence of provider network calls.

## Migration, Compose, and readiness

- `docker compose -f compose.yaml config --volumes`
  - Reported `minio_data` and `postgres_data`.
- Before startup, `docker volume inspect sovara-studio-postgres-data sovara-studio-minio-data`
  - PASS. Both declared local-driver named volumes existed.
- `docker compose -f compose.yaml up -d postgres redis minio minio-init`
  - PASS. PostgreSQL, Redis, and MinIO reached healthy status; `minio-init` created/privatized `sovara-uploads` and exited successfully.
- `pnpm build`
  - PASS. All seven buildable workspace projects completed.
- `node --env-file=.env packages/db/dist/migrate.js`
  - PASS. The compiled migration entry point completed with the local environment loaded in the same command context.
- `docker compose -f compose.yaml up -d --build api worker web`
  - PASS. API, worker, and web images built and services started.
- Explicit readiness polling after startup:
  - API `http://localhost:13000/api/ready`: HTTP 200.
  - Worker `http://localhost:13001/ready`: HTTP 200.
  - Web `/`: HTTP 200 at `http://localhost:18080/`.

## Test and static results

- Focused integration command, with `.env` loaded into the same process:
  - `node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/task-013-publication-draft.integration.test.ts`
  - PASS — 1 file, 3 tests, 0 failed, 0 skipped.
- Full integration command, with `.env` loaded into the same process:
  - `node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts`
  - PASS — 12 files, 53 tests, 0 failed, 0 skipped.
- `pnpm lint`
  - PASS.
- `pnpm typecheck`
  - PASS.
- `pnpm test`
  - PASS — 40 files, 281 tests, 0 failed.
- Final formatting verification after the reload-status assertion:
  - `pnpm format:check`
  - PASS — all matched files use Prettier code style.
- `pnpm auth:schema:check`
  - PASS — Better Auth 1.7.2 Drizzle schema compatibility.
- `pnpm web:bundle:check`
  - PASS — executed `dist/bundle-smoke-31QzMTcG.js` and parsed upload status.

## Volume cleanup evidence

- Compose emitted warnings for two pre-existing undeclared legacy-labelled volumes, `sovarastudio_postgres_data` and `sovarastudio_minio_data`; they are distinct from the declared `sovara-studio-*` volumes and were not modified.
- `docker compose -f compose.yaml down`
  - PASS. Containers and the Compose network were removed without `--volumes`.
- After cleanup, `docker volume inspect sovara-studio-postgres-data sovara-studio-minio-data`
  - PASS. Both declared local-driver volumes still existed under those exact names with their original creation timestamps.

## Final state

- Changed files: `tests/integration/task-013-publication-draft.integration.test.ts` and `REVIEW_REPORT.md`.
- No production source changes and no packaging were performed.
