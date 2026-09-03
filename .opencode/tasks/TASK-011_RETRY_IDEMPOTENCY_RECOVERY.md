# TASK-011 — RETRY / IDEMPOTENCY / RECOVERY

Requirements:

- configurable retry attempts/backoff;
- retry transient network/429/5xx failures;
- do not endlessly retry auth/permission/validation failures;
- DB uniqueness/transaction safety for publication creation;
- same queue job can be redelivered safely;
- analyze the crash window: remote platform success -> local persistence;
- preserve resumable session/reconciliation data when platform supports it;
- allow explicit retry of FAILED publication without reuploading source to S3.
