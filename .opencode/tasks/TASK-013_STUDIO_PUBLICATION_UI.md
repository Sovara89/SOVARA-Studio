# TASK-013 — STUDIO PUBLICATION UI / STATUS

Integrate into Studio UI.

Requirements:

- publish only READY source;
- selectable YouTube / VK Video;
- independent status per platform;
- progress/result/error;
- duplicate publish request must not blindly duplicate publication;
- use existing realtime mechanism if one exists; otherwise simple polling is acceptable;
- user-facing safe errors.

## TASK-013 repair record

- Preview removal now treats the owner-scoped revision-CAS PostgreSQL unlink as authoritative;
  best-effort private-storage cleanup cannot turn that successful API response into a failure.
- VK metadata links are editable and clearable. New VK drafts default to
  `https://vk.com/sovara_news`; clears persist as `NULL`; accepted values are bounded,
  credential-free HTTPS URLs on `vk.com` or its subdomains.
- Saving a draft remains intent-only and does not enqueue or call a publication provider.
