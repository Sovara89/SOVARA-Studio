# TASK-001 — PROJECT AUDIT ONLY

## Goal

Understand the real SOVARA Studio architecture before any implementation.

## Do

Inspect:

- frontend framework and structure;
- backend/API;
- auth/session/user model;
- database/ORM/migrations;
- existing upload/storage code;
- existing YouTube/VK integrations;
- queue/background jobs;
- Docker/local services;
- environment configuration;
- logging/testing/CI;
- current Studio video/publishing UI.

## Do NOT

- edit files;
- install dependencies;
- add migrations;
- create services;
- copy code from SOVARA Widgets.

## Deliverable

A plan describing:

- what already exists;
- what can be reused;
- missing pieces;
- exact proposed files for TASK-002;
- risks;
- architecture direction.

Then STOP.
