# TASK-014 — RELIABILITY / SECURITY / TESTS / FINAL VERIFY

Finish production-hardening.

Reliability:

- configurable retry/backoff;
- transient vs permanent classification;
- idempotency and race handling;
- crash window around remote success/local persistence;
- explicit retry of FAILED publication;
- cleanup of incomplete multipart uploads;
- temporary worker file cleanup if used.

Security:

- ownership everywhere;
- private source objects;
- no secret/token leakage;
- no arbitrary object keys from client;
- secure credential storage.

Tests:

- tests must exercise production code;
- no copied helper implementations inside tests;
- no silent `return` green tests when DB/services missing;
- explicit BLOCKED/SKIP semantics where needed.

Final:
run studio-review then studio-verify.
Produce factual final report only after real checks.
