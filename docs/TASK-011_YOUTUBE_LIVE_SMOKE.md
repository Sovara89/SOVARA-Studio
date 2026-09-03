# TASK-011 YouTube live smoke

Live smoke is manual and is not run by the automated test suite.

1. Configure `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and
   `YOUTUBE_REDIRECT_URI` in the API and worker environments.
2. Configure the worker credential keyring and private S3-compatible storage.
3. Connect a YouTube account through the API OAuth flow.
4. Upload and verify a small source video, then create one YouTube publication.
5. Confirm the publication reaches `published` and that the persisted remote ID
   belongs to the connected channel.
6. Confirm worker logs and queue data contain no access token, refresh token,
   credential ciphertext, or resumable session URL.

If OAuth credentials or external services are unavailable, report `NOT
AVAILABLE` rather than substituting a fake live result.
