# REJECTED ATTEMPT — DO NOT REPEAT

A previous attempt was rejected.

Mandatory lessons:

1. It implemented inside SOVARA Widgets instead of SOVARA Studio.
2. Multipart frontend/backend ETag flow was incomplete.
3. Parts were too small and uploads were serial.
4. Max size was hardcoded to 10 GB.
5. Backend marked source READY without final S3 HEAD/metadata verification.
6. YouTube/VK code buffered the whole video into RAM.
7. OAuth was reported complete while callback/token lifecycle was missing.
8. Token refresh happened incorrectly and refreshed credentials were not persisted/used.
9. Hardcoded user ID replaced real auth/session ownership.
10. OAuth credentials were handled unsafely.
11. Idempotency did not cover worker crash after remote success.
12. Retry documentation did not match actual backoff.
13. Some tests tested copied helpers instead of production code.
14. Some integration tests silently returned without DB and still appeared green.

Every relevant review must explicitly check these failure classes.
