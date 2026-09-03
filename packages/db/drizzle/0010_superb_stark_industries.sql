ALTER TABLE "publication" ADD COLUMN "retry_cycle_attempt_count" integer;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "retry_cycle_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "publication"
SET "retry_cycle_attempt_count" = "attempt_count",
    "retry_cycle_started_at" = "created_at";--> statement-breakpoint
ALTER TABLE "publication" ALTER COLUMN "retry_cycle_attempt_count" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "publication" ALTER COLUMN "retry_cycle_attempt_count" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "publication" ALTER COLUMN "retry_cycle_started_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "publication" ALTER COLUMN "retry_cycle_started_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_retry_cycle_attempt_count_check" CHECK ("publication"."retry_cycle_attempt_count" >= 0);
