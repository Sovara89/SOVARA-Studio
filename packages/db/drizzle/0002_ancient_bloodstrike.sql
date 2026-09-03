ALTER TABLE "publication" DROP CONSTRAINT "publication_published_check";--> statement-breakpoint
ALTER TABLE "publication_attempt" DROP CONSTRAINT "publication_attempt_request_sent_check";--> statement-breakpoint
DROP INDEX "publication_platform_remoteMediaId_uidx";--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "remote_owner_id" text;--> statement-breakpoint
ALTER TABLE "publication_attempt" ADD COLUMN "remote_owner_id" text;--> statement-breakpoint
UPDATE "publication_attempt" AS "attempt"
SET "state" = 'manual_review',
	"failure_class" = 'ambiguous',
	"failure_code" = 'VK_LEGACY_REMOTE_OWNER_UNVERIFIED',
	"failure_message" = NULL,
	"revision" = "attempt"."revision" + 1,
	"updated_at" = now()
FROM "publication" AS "legacy_publication"
WHERE "attempt"."publication_id" = "legacy_publication"."id"
	AND "legacy_publication"."platform" = 'vk'
	AND "legacy_publication"."state" = 'published'
	AND "legacy_publication"."remote_media_id" IS NOT NULL
	AND "attempt"."state" IN ('succeeded', 'reconciled_succeeded');--> statement-breakpoint
UPDATE "publication"
SET "state" = 'manual_review',
	"failure_class" = 'ambiguous',
	"failure_code" = 'VK_LEGACY_REMOTE_OWNER_UNVERIFIED',
	"failure_message" = NULL,
	"next_attempt_at" = NULL,
	"lease_token" = NULL,
	"lease_expires_at" = NULL,
	"revision" = "publication"."revision" + 1,
	"updated_at" = now()
WHERE "platform" = 'vk'
	AND "state" = 'published'
	AND "remote_media_id" IS NOT NULL
	AND "remote_owner_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_vk_remoteOwnerId_remoteMediaId_uidx" ON "publication" USING btree ("platform","remote_owner_id","remote_media_id") WHERE "publication"."platform" = 'vk' AND "publication"."remote_owner_id" IS NOT NULL AND "publication"."remote_media_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_platform_remoteMediaId_uidx" ON "publication" USING btree ("platform","remote_media_id") WHERE "publication"."platform" = 'youtube' AND "publication"."remote_media_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "video" ADD CONSTRAINT "video_failed_check" CHECK ("video"."state" <> 'failed' OR "video"."failure_code" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "video" ADD CONSTRAINT "video_deleted_timestamp_check" CHECK ("video"."state" <> 'deletion_pending' OR "video"."deleted_at" IS NULL);--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_remote_identity_check" CHECK ("publication"."remote_owner_id" IS NULL OR "publication"."platform" = 'vk');--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_remote_identity_pair_check" CHECK ("publication"."remote_owner_id" IS NULL OR "publication"."remote_media_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_published_check" CHECK ("publication"."state" <> 'published' OR ("publication"."published_at" IS NOT NULL AND "publication"."remote_media_id" IS NOT NULL AND (("publication"."platform" = 'youtube' AND "publication"."remote_owner_id" IS NULL) OR ("publication"."platform" = 'vk' AND "publication"."remote_owner_id" IS NOT NULL))));--> statement-breakpoint
ALTER TABLE "publication_attempt" ADD CONSTRAINT "publication_attempt_remote_identity_pair_check" CHECK ("publication_attempt"."remote_owner_id" IS NULL OR "publication_attempt"."remote_media_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "publication_attempt" ADD CONSTRAINT "publication_attempt_request_sent_check" CHECK ("publication_attempt"."state" NOT IN ('request_sent', 'succeeded', 'ambiguous', 'reconciled_succeeded', 'reconciled_absent', 'manual_review') OR "publication_attempt"."request_sent_at" IS NOT NULL);
