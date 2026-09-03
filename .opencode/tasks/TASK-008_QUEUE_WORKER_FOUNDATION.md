# TASK-008 — QUEUE + WORKER FOUNDATION

Implement approved queue technology.

Requirements:

- HTTP API enqueues work and returns quickly;
- worker runs independently;
- stable job IDs/payloads;
- publication state/progress persisted;
- YouTube and VK are separate jobs;
- redelivery-safe worker behavior;
- retry primitives;
- DLQ/failed-job strategy according to chosen queue.

No monolithic PublishEverywhere job.
