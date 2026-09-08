ALTER TABLE "runs" ADD COLUMN "sandbox_replacement_workspace_provider" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox_replacement_workspace_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sandbox_image_provider" text;