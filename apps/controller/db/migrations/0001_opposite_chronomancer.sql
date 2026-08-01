CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"profile" text NOT NULL,
	"provider" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"repo" jsonb NOT NULL,
	"model" text NOT NULL,
	"active_run_id" uuid,
	"latest_run_id" uuid NOT NULL,
	"turn_count" integer DEFAULT 1 NOT NULL,
	"agent_checkpoint" text,
	"sandbox_provider" text,
	"sandbox_id" text,
	"workspace_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "turn_number" integer;--> statement-breakpoint
CREATE INDEX "sessions_updated_idx" ON "sessions" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_workspace_expiry_idx" ON "sessions" USING btree ("workspace_expires_at") WHERE "sessions"."sandbox_id" is not null and "sessions"."active_run_id" is null;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;