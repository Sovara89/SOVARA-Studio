# TASK-006 — QUEUE + WORKER FOUNDATION

Use existing project queue/background mechanism if one exists.

Requirements:

- HTTP API creates publication records/jobs and returns quickly;
- worker runs outside request lifecycle;
- YouTube and VK publications are independent jobs;
- job payload uses stable IDs, not secrets;
- state/progress updates are persisted;
- worker can safely receive the same job again.

Do not build one monolithic PublishEverywhere job.
