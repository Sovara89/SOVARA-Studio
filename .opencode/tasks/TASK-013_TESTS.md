# TASK-013 — TESTS

Tests must exercise production code.

Cover relevant cases:

- upload create/presign/complete;
- ownership;
- invalid size/type;
- part/ETag completion;
- missing/wrong S3 object metadata;
- duplicate complete;
- publication creation;
- duplicate publication;
- queue retry;
- already-completed job;
- transient/permanent platform errors;
- OAuth refresh behavior;
- idempotency.

Forbidden:

- redefining/copying a production helper inside a test and only testing the copy;
- silently returning from an integration test when DB/service is absent while reporting success.

Use explicit skip/blocking semantics where infrastructure is unavailable.
