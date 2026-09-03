ALTER TABLE "multipart_upload" DROP CONSTRAINT "multipart_upload_provider_id_check";--> statement-breakpoint
ALTER TABLE "multipart_upload" DROP CONSTRAINT "multipart_upload_state_check";--> statement-breakpoint
DROP INDEX "multipart_upload_unresolved_video_uidx";--> statement-breakpoint
ALTER TABLE "multipart_upload" ALTER COLUMN "provider_upload_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "multipart_upload_unresolved_video_uidx" ON "multipart_upload" USING btree ("video_id") WHERE "multipart_upload"."state" IN ('initiating', 'active', 'completing', 'abort_pending', 'failed');--> statement-breakpoint
ALTER TABLE "multipart_upload" ADD CONSTRAINT "multipart_upload_provider_id_check" CHECK ("multipart_upload"."provider_upload_id" IS NULL OR length(trim("multipart_upload"."provider_upload_id")) > 0);--> statement-breakpoint
ALTER TABLE "multipart_upload" ADD CONSTRAINT "multipart_upload_state_check" CHECK ("multipart_upload"."state" IN ('initiating', 'active', 'completing', 'completed', 'abort_pending', 'aborted', 'expired', 'failed'));