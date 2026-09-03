# SOVARA Studio production storage contract

This document is an explicit deployment contract. It does not configure a
provider automatically.

## Required storage policy

- The upload bucket is private; anonymous object reads are denied.
- Bucket CORS allows only the deployed Studio web origin(s). `*` is forbidden.
- Presigned `UploadPart` requests allow `PUT` from those origins.
- `ETag` is exposed to the browser. Any checksum response headers used by the
  uploader are exposed explicitly as well.
- Incomplete multipart uploads are removed by provider lifecycle policy.
- API IAM credentials are restricted to the upload bucket and the `sources/`
  prefix. The policy should grant only the required `s3:PutObject`,
  `s3:AbortMultipartUpload`, `s3:ListBucketMultipartUploads`, and multipart
  upload initiation permissions; `s3:ListBucket` must be prefix-scoped to
  `sources/`. No read, delete, or bucket-administration permission is needed
  by TASK-005.
- `S3_ENDPOINT` is the API control-plane endpoint. `S3_PRESIGN_ENDPOINT` is
  the browser-reachable endpoint used only when constructing presigned URLs.
  They may be equal in production when the endpoint is reachable from both
  API and browser networks.

## Local-only MinIO workaround

Local Compose uses `MINIO_API_CORS_ALLOW_ORIGIN` with the two intended local
Studio origins because the pinned open-source MinIO image does not support
the bucket-level CORS API used by `mc cors set`. This global setting is
LOCAL-ONLY and is not a production storage policy.
