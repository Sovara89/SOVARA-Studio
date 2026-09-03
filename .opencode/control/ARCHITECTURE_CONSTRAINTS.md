# PRODUCT ARCHITECTURE CONSTRAINTS

SOVARA Studio is a standalone web application for creators.

This document contains constraints, NOT a preselected framework.

TASK-001 must propose the stack and justify it before any code is created.

## Required capabilities

The approved architecture must support:

- web frontend;
- backend API;
- authentication/session model;
- PostgreSQL;
- migrations;
- S3-compatible private object storage;
- browser-side multipart upload;
- background queue;
- independent worker process;
- YouTube account/OAuth integration;
- VK Video account/OAuth integration;
- per-platform publication state/progress;
- local development with reproducible services;
- tests;
- production deployment without forcing all components into one process.

## Architecture preference

Prefer:

- one repository;
- a small number of apps/packages;
- shared types/contracts where useful;
- clear separation between HTTP API and workers;
- no unnecessary microservices.

TASK-001 must compare no more than 2 reasonable stack options and recommend exactly 1.

The recommendation must include:

- frontend;
- API/backend;
- ORM;
- database;
- queue;
- worker model;
- S3 client;
- auth strategy;
- validation;
- test stack;
- local orchestration;
- package manager;
- repository layout.

No implementation in TASK-001.
