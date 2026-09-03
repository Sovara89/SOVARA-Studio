# TASK-008 — YOUTUBE PUBLISHER

Requirements:

- use real existing user OAuth/account model;
- implement/complete actual OAuth flow if Studio lacks it;
- access-token refresh before/when needed;
- persist refreshed credentials securely;
- use refreshed credential for the current operation;
- resumable/streaming upload suitable for large video;
- never convert the whole source video to Blob/Buffer in RAM;
- metadata support consistent with product UI;
- persist external id/url/status;
- classify transient vs permanent errors;
- design crash/retry behavior to minimize duplicate remote videos.

Do not claim OAuth complete if callback/token lifecycle is missing.
