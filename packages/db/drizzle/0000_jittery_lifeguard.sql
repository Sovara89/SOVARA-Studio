CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publishing_account" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"provider_account_id" text,
	"display_name" text,
	"access_token_ciphertext" text,
	"refresh_token_ciphertext" text,
	"access_token_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"credential_format_version" smallint,
	"credential_key_id" text,
	"credential_updated_at" timestamp with time zone,
	"credential_revision" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publishing_account_platform_check" CHECK ("publishing_account"."platform" IN ('youtube', 'vk')),
	CONSTRAINT "publishing_account_status_check" CHECK ("publishing_account"."status" IN ('pending', 'active', 'reauthorization_required', 'revoked')),
	CONSTRAINT "publishing_account_revision_check" CHECK ("publishing_account"."credential_revision" >= 0),
	CONSTRAINT "publishing_account_active_credentials_check" CHECK ("publishing_account"."status" <> 'active' OR ("publishing_account"."provider_account_id" IS NOT NULL AND "publishing_account"."access_token_ciphertext" IS NOT NULL AND "publishing_account"."credential_format_version" IS NOT NULL AND "publishing_account"."credential_key_id" IS NOT NULL AND "publishing_account"."credential_updated_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishing_account" ADD CONSTRAINT "publishing_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "publishing_account_userId_idx" ON "publishing_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "publishing_account_userId_platform_idx" ON "publishing_account" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "publishing_account_userId_status_idx" ON "publishing_account" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "publishing_account_platform_providerAccountId_uidx" ON "publishing_account" USING btree ("platform","provider_account_id") WHERE "publishing_account"."provider_account_id" IS NOT NULL;