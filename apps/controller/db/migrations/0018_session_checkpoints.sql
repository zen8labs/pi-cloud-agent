-- Setup scripts have no safe image equivalent; require users to re-enter a base image.
TRUNCATE TABLE "repository_environments";
ALTER TABLE "repository_environments" ADD COLUMN "image_ref" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "retention_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "checkpoint_size_bytes" bigint;--> statement-breakpoint
UPDATE "sessions"
SET "retention_status" = 'inactive'
WHERE "sandbox_id" IS NULL AND "active_run_id" IS NULL;--> statement-breakpoint
CREATE INDEX "sessions_retention_activity_idx" ON "sessions" USING btree ("retention_status","last_activity_at") WHERE "active_run_id" is null;--> statement-breakpoint
ALTER TABLE "repository_environments" DROP COLUMN "setup_script";
