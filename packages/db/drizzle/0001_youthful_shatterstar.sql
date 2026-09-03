CREATE TABLE "video" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"expected_size_bytes" bigint NOT NULL,
	"verified_size_bytes" bigint,
	"storage_backend" text NOT NULL,
	"storage_bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"object_version_id" text,
	"object_etag" text,
	"verified_checksum_algorithm" text,
	"verified_checksum_value" text,
	"state" text DEFAULT 'awaiting_upload' NOT NULL,
	"verified_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"deletion_requested_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_id_userId_key" UNIQUE("id","user_id"),
	CONSTRAINT "video_original_filename_check" CHECK (length(trim("video"."original_filename")) > 0),
	CONSTRAINT "video_content_type_check" CHECK (length(trim("video"."content_type")) > 0),
	CONSTRAINT "video_expected_size_check" CHECK ("video"."expected_size_bytes" > 0),
	CONSTRAINT "video_verified_size_check" CHECK ("video"."verified_size_bytes" IS NULL OR "video"."verified_size_bytes" >= 0),
	CONSTRAINT "video_storage_identity_check" CHECK (length(trim("video"."storage_backend")) > 0 AND length(trim("video"."storage_bucket")) > 0 AND length(trim("video"."object_key")) > 0),
	CONSTRAINT "video_checksum_pair_check" CHECK (("video"."verified_checksum_algorithm" IS NULL AND "video"."verified_checksum_value" IS NULL) OR ("video"."verified_checksum_algorithm" IS NOT NULL AND "video"."verified_checksum_value" IS NOT NULL AND length(trim("video"."verified_checksum_value")) > 0)),
	CONSTRAINT "video_checksum_algorithm_check" CHECK ("video"."verified_checksum_algorithm" IS NULL OR "video"."verified_checksum_algorithm" IN ('sha256', 'sha1', 'crc32', 'crc32c', 'crc64nvme')),
	CONSTRAINT "video_state_check" CHECK ("video"."state" IN ('awaiting_upload', 'uploading', 'uploaded', 'verifying', 'ready', 'invalid', 'failed', 'deletion_pending', 'deleted')),
	CONSTRAINT "video_revision_check" CHECK ("video"."revision" >= 0),
	CONSTRAINT "video_ready_check" CHECK ("video"."state" <> 'ready' OR ("video"."verified_at" IS NOT NULL AND "video"."verified_size_bytes" = "video"."expected_size_bytes" AND "video"."failure_code" IS NULL AND "video"."failure_message" IS NULL)),
	CONSTRAINT "video_invalid_check" CHECK ("video"."state" <> 'invalid' OR ("video"."verified_at" IS NOT NULL AND "video"."failure_code" IS NOT NULL)),
	CONSTRAINT "video_failure_pair_check" CHECK ("video"."failure_message" IS NULL OR "video"."failure_code" IS NOT NULL),
	CONSTRAINT "video_deleted_check" CHECK ("video"."state" NOT IN ('deletion_pending', 'deleted') OR "video"."deletion_requested_at" IS NOT NULL),
	CONSTRAINT "video_deleted_at_check" CHECK ("video"."state" <> 'deleted' OR "video"."deleted_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "multipart_upload" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"provider_upload_id" text NOT NULL,
	"part_size_bytes" bigint NOT NULL,
	"expected_part_count" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completion_requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"failure_code" text,
	"failure_message" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "multipart_upload_id_userId_key" UNIQUE("id","user_id"),
	CONSTRAINT "multipart_upload_provider_id_check" CHECK (length(trim("multipart_upload"."provider_upload_id")) > 0),
	CONSTRAINT "multipart_upload_part_size_check" CHECK ("multipart_upload"."part_size_bytes" > 0),
	CONSTRAINT "multipart_upload_part_count_check" CHECK ("multipart_upload"."expected_part_count" BETWEEN 1 AND 10000),
	CONSTRAINT "multipart_upload_state_check" CHECK ("multipart_upload"."state" IN ('active', 'completing', 'completed', 'abort_pending', 'aborted', 'expired', 'failed')),
	CONSTRAINT "multipart_upload_revision_check" CHECK ("multipart_upload"."revision" >= 0),
	CONSTRAINT "multipart_upload_completion_check" CHECK ("multipart_upload"."state" <> 'completing' OR "multipart_upload"."completion_requested_at" IS NOT NULL),
	CONSTRAINT "multipart_upload_completed_check" CHECK ("multipart_upload"."state" <> 'completed' OR "multipart_upload"."completed_at" IS NOT NULL),
	CONSTRAINT "multipart_upload_closed_check" CHECK ("multipart_upload"."state" NOT IN ('aborted', 'expired') OR "multipart_upload"."closed_at" IS NOT NULL),
	CONSTRAINT "multipart_upload_failure_pair_check" CHECK ("multipart_upload"."failure_message" IS NULL OR "multipart_upload"."failure_code" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "upload_part" (
	"multipart_upload_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"etag" text NOT NULL,
	"reported_size_bytes" bigint,
	"provider_checksum_algorithm" text,
	"provider_checksum_value" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_part_multipart_upload_id_part_number_pk" PRIMARY KEY("multipart_upload_id","part_number"),
	CONSTRAINT "upload_part_number_check" CHECK ("upload_part"."part_number" BETWEEN 1 AND 10000),
	CONSTRAINT "upload_part_etag_check" CHECK (length(trim("upload_part"."etag")) > 0),
	CONSTRAINT "upload_part_size_check" CHECK ("upload_part"."reported_size_bytes" IS NULL OR "upload_part"."reported_size_bytes" > 0),
	CONSTRAINT "upload_part_checksum_pair_check" CHECK (("upload_part"."provider_checksum_algorithm" IS NULL AND "upload_part"."provider_checksum_value" IS NULL) OR ("upload_part"."provider_checksum_algorithm" IS NOT NULL AND "upload_part"."provider_checksum_value" IS NOT NULL AND length(trim("upload_part"."provider_checksum_value")) > 0)),
	CONSTRAINT "upload_part_checksum_algorithm_check" CHECK ("upload_part"."provider_checksum_algorithm" IS NULL OR "upload_part"."provider_checksum_algorithm" IN ('sha256', 'sha1', 'crc32', 'crc32c', 'crc64nvme')),
	CONSTRAINT "upload_part_revision_check" CHECK ("upload_part"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "publishing_account" ADD CONSTRAINT "publishing_account_id_userId_platform_key" UNIQUE("id","user_id","platform");--> statement-breakpoint
CREATE TABLE "publication" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"publishing_account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"metadata_version" smallint DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"remote_media_id" text,
	"remote_url" text,
	"published_at" timestamp with time zone,
	"reconciliation_required_at" timestamp with time zone,
	"failure_class" text,
	"failure_code" text,
	"failure_message" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_id_userId_key" UNIQUE("id","user_id"),
	CONSTRAINT "publication_platform_check" CHECK ("publication"."platform" IN ('youtube', 'vk')),
	CONSTRAINT "publication_state_check" CHECK ("publication"."state" IN ('queued', 'publishing', 'reconciling', 'retry_wait', 'manual_review', 'published', 'failed', 'cancelled')),
	CONSTRAINT "publication_title_check" CHECK (length(trim("publication"."title")) > 0),
	CONSTRAINT "publication_metadata_version_check" CHECK ("publication"."metadata_version" > 0),
	CONSTRAINT "publication_attempt_count_check" CHECK ("publication"."attempt_count" >= 0),
	CONSTRAINT "publication_revision_check" CHECK ("publication"."revision" >= 0),
	CONSTRAINT "publication_lease_pair_check" CHECK (("publication"."lease_token" IS NULL AND "publication"."lease_expires_at" IS NULL) OR ("publication"."lease_token" IS NOT NULL AND "publication"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "publication_retry_check" CHECK ("publication"."state" <> 'retry_wait' OR "publication"."next_attempt_at" IS NOT NULL),
	CONSTRAINT "publication_reconcile_check" CHECK ("publication"."state" <> 'reconciling' OR "publication"."reconciliation_required_at" IS NOT NULL),
	CONSTRAINT "publication_published_check" CHECK ("publication"."state" <> 'published' OR ("publication"."remote_media_id" IS NOT NULL AND "publication"."published_at" IS NOT NULL)),
	CONSTRAINT "publication_failure_pair_check" CHECK ("publication"."failure_message" IS NULL OR "publication"."failure_code" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "publication_attempt" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"state" text NOT NULL,
	"provider_request_id" text,
	"remote_media_id" text,
	"remote_url" text,
	"failure_class" text,
	"failure_code" text,
	"failure_message" text,
	"request_sent_at" timestamp with time zone,
	"reconciliation_checked_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_attempt_id_userId_key" UNIQUE("id","user_id"),
	CONSTRAINT "publication_attempt_state_check" CHECK ("publication_attempt"."state" IN ('started', 'request_sent', 'succeeded', 'definitely_failed', 'ambiguous', 'reconciled_succeeded', 'reconciled_absent', 'manual_review')),
	CONSTRAINT "publication_attempt_number_check" CHECK ("publication_attempt"."attempt_number" > 0),
	CONSTRAINT "publication_attempt_revision_check" CHECK ("publication_attempt"."revision" >= 0),
	CONSTRAINT "publication_attempt_request_sent_check" CHECK ("publication_attempt"."state" NOT IN ('request_sent', 'succeeded', 'definitely_failed', 'ambiguous', 'reconciled_succeeded', 'reconciled_absent', 'manual_review') OR "publication_attempt"."request_sent_at" IS NOT NULL),
	CONSTRAINT "publication_attempt_success_check" CHECK ("publication_attempt"."state" NOT IN ('succeeded', 'reconciled_succeeded') OR "publication_attempt"."remote_media_id" IS NOT NULL),
	CONSTRAINT "publication_attempt_terminal_time_check" CHECK ("publication_attempt"."state" NOT IN ('succeeded', 'definitely_failed', 'reconciled_succeeded', 'reconciled_absent') OR "publication_attempt"."finished_at" IS NOT NULL),
	CONSTRAINT "publication_attempt_failure_pair_check" CHECK ("publication_attempt"."failure_message" IS NULL OR "publication_attempt"."failure_code" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "video" ADD CONSTRAINT "video_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multipart_upload" ADD CONSTRAINT "multipart_upload_video_user_fk" FOREIGN KEY ("video_id","user_id") REFERENCES "public"."video"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_part" ADD CONSTRAINT "upload_part_upload_user_fk" FOREIGN KEY ("multipart_upload_id","user_id") REFERENCES "public"."multipart_upload"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_video_user_fk" FOREIGN KEY ("video_id","user_id") REFERENCES "public"."video"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_publishing_account_user_platform_fk" FOREIGN KEY ("publishing_account_id","user_id","platform") REFERENCES "public"."publishing_account"("id","user_id","platform") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_attempt" ADD CONSTRAINT "publication_attempt_publication_user_fk" FOREIGN KEY ("publication_id","user_id") REFERENCES "public"."publication"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_storage_tuple_uidx" ON "video" USING btree ("storage_backend","storage_bucket","object_key");--> statement-breakpoint
CREATE INDEX "video_userId_createdAt_idx" ON "video" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "video_userId_state_updatedAt_idx" ON "video" USING btree ("user_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "video_attention_idx" ON "video" USING btree ("state","updated_at") WHERE "video"."state" IN ('uploaded', 'verifying', 'deletion_pending');--> statement-breakpoint
CREATE UNIQUE INDEX "multipart_upload_video_providerUploadId_uidx" ON "multipart_upload" USING btree ("video_id","provider_upload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "multipart_upload_unresolved_video_uidx" ON "multipart_upload" USING btree ("video_id") WHERE "multipart_upload"."state" IN ('active', 'completing', 'abort_pending', 'failed');--> statement-breakpoint
CREATE INDEX "multipart_upload_userId_state_expiresAt_idx" ON "multipart_upload" USING btree ("user_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "multipart_upload_videoId_createdAt_idx" ON "multipart_upload" USING btree ("video_id","created_at");--> statement-breakpoint
CREATE INDEX "upload_part_userId_uploadId_idx" ON "upload_part" USING btree ("user_id","multipart_upload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_video_account_uidx" ON "publication" USING btree ("video_id","publishing_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_platform_remoteMediaId_uidx" ON "publication" USING btree ("platform","remote_media_id") WHERE "publication"."remote_media_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "publication_userId_videoId_idx" ON "publication" USING btree ("user_id","video_id");--> statement-breakpoint
CREATE INDEX "publication_userId_state_updatedAt_idx" ON "publication" USING btree ("user_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "publication_work_idx" ON "publication" USING btree ("state","next_attempt_at") WHERE "publication"."state" IN ('queued', 'retry_wait');--> statement-breakpoint
CREATE INDEX "publication_lease_idx" ON "publication" USING btree ("state","lease_expires_at") WHERE "publication"."state" IN ('publishing', 'reconciling');--> statement-breakpoint
CREATE UNIQUE INDEX "publication_attempt_publication_number_uidx" ON "publication_attempt" USING btree ("publication_id","attempt_number");--> statement-breakpoint
CREATE INDEX "publication_attempt_userId_publicationId_idx" ON "publication_attempt" USING btree ("user_id","publication_id");--> statement-breakpoint
CREATE INDEX "publication_attempt_state_startedAt_idx" ON "publication_attempt" USING btree ("state","started_at");--> statement-breakpoint
