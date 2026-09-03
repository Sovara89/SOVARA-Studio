# TASK-010 — STUDIO PUBLICATION FLOW

Use existing Studio UX.

Allow publication to:

- YouTube
- VK Video

Do not expose Rutube for this phase.

Requirements:

- only READY sources can publish;
- separate publication record/job per platform;
- duplicate publish request must not blindly duplicate publications;
- show status/progress/result/error per platform;
- use existing realtime mechanism if present; otherwise a simple status polling path is acceptable.
