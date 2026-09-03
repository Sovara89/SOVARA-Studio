# TASK-007 — PLATFORM PUBLISHER ABSTRACTION

Create a small abstraction aligned with the existing codebase.

Implementations planned:

- YouTube
- VK Video

Do not implement Rutube now.

Separate:

- orchestration/state/retry in worker layer;
- platform-specific API behavior in publisher layer.

Adding another platform later should not require rewriting the worker.
