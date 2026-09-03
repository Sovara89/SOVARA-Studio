# TASK-001 — GREENFIELD ARCHITECTURE ONLY

## Context

SOVARA Studio is a NEW standalone application.
The current workspace may contain only the OpenCode control pack.
That is expected and MUST NOT block planning.

## Goal

Design the initial architecture. Do not create application files.

## Required analysis

Propose no more than 2 sensible stack options and recommend exactly 1.

The recommendation must specify:

- package manager;
- repository layout;
- frontend framework;
- backend/API framework;
- shared contracts/types approach;
- authentication/session approach;
- PostgreSQL;
- ORM and migrations;
- validation;
- S3-compatible storage client;
- queue technology;
- worker execution model;
- YouTube/VK integration boundaries;
- test stack;
- local development orchestration;
- production deployment shape;
- environment/secrets strategy;
- logging/observability baseline.

## Constraints

- standalone from SOVARA Widgets;
- one repo preferred;
- no unnecessary microservices;
- API and workers separate at runtime;
- browser -> private S3 direct multipart upload;
- large video never fully buffered in backend/worker RAM;
- independent YouTube/VK jobs;
- architecture must support retry/idempotency.

## Deliverable

Return:

1. Option A.
2. Option B only if genuinely useful.
3. Recommended option.
4. Why.
5. Proposed directory tree.
6. Exact files TASK-002 should create.
7. Initial commands TASK-002 would run.
8. Risks.
9. Verification plan.

STOP. No code.
