ALTER TABLE "sessions" ADD COLUMN "session_operation" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "session_operation_at" timestamp with time zone;--> statement-breakpoint
UPDATE "sessions" SET "sandbox_image_ref" = NULL WHERE "sandbox_image_ref" = '';
