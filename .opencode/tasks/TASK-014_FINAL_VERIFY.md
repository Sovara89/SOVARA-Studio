# TASK-014 — FINAL AUDIT

Run studio-review, then studio-verify.

Confirm:

- active repo is SOVARA Studio;
- Browser -> private S3 direct multipart upload;
- coherent ETag -> CompleteMultipartUpload flow;
- final S3 HEAD verification;
- large video never fully buffered in backend/worker RAM;
- queue + worker separation;
- independent YouTube/VK jobs;
- real auth/OAuth lifecycle;
- retry/idempotency;
- no exposed secrets;
- tests exercise production code.

Produce a final factual report only after real checks.
Do not create a PASS claim for checks that were not run.
