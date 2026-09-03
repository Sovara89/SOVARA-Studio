ALTER TABLE "publication_intent" ALTER COLUMN "link" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "publication_intent" ALTER COLUMN "link" DROP NOT NULL;
