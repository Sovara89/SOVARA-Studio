CREATE TABLE "oauth_transaction" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier_ciphertext" text NOT NULL,
	"publishing_account_id" uuid,
	"redirect_uri" text NOT NULL,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_transaction_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "oauth_transaction_platform_check" CHECK ("oauth_transaction"."platform" IN ('youtube', 'vk'))
);
--> statement-breakpoint
ALTER TABLE "publishing_account" ADD COLUMN "refresh_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "publishing_account" ADD COLUMN "refresh_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publishing_account" ADD COLUMN "provider_device_id_ciphertext" text;--> statement-breakpoint
ALTER TABLE "oauth_transaction" ADD CONSTRAINT "oauth_transaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_transaction" ADD CONSTRAINT "oauth_transaction_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_transaction_userId_idx" ON "oauth_transaction" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_transaction_expiresAt_idx" ON "oauth_transaction" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "publishing_account" ADD CONSTRAINT "publishing_account_refresh_lease_pair_check" CHECK (("publishing_account"."refresh_lease_token" IS NULL AND "publishing_account"."refresh_lease_expires_at" IS NULL) OR ("publishing_account"."refresh_lease_token" IS NOT NULL AND "publishing_account"."refresh_lease_expires_at" IS NOT NULL));