ALTER TABLE "publication_intent" ADD COLUMN "pending_preview_object_key" text;--> statement-breakpoint
ALTER TABLE "publication_intent" ADD COLUMN "pending_preview_content_type" text;--> statement-breakpoint
ALTER TABLE "publication_intent" ADD COLUMN "pending_preview_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "publication_intent" ADD CONSTRAINT "publication_intent_pending_preview_check" CHECK (("pending_preview_object_key" IS NULL AND "pending_preview_content_type" IS NULL AND "pending_preview_size_bytes" IS NULL) OR ("preview_state" = 'ready' AND "preview_object_key" IS NOT NULL AND "pending_preview_object_key" IS NOT NULL AND "pending_preview_content_type" IN ('image/jpeg', 'image/png', 'image/webp') AND "pending_preview_size_bytes" > 0));
