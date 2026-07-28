CREATE TABLE "repo_config" (
	"provider" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"profile" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_config_provider_repo_full_name_profile_pk" PRIMARY KEY("provider","repo_full_name","profile")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"model" text NOT NULL,
	"callback_token" text NOT NULL,
	"sandbox_provider" text,
	"sandbox_id" text,
	"sandbox_stopped_at" timestamp with time zone,
	"event_seq" integer DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_status_created_idx" ON "runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_sandbox_idx" ON "runs" USING btree ("sandbox_id") WHERE "runs"."sandbox_id" is not null and "runs"."sandbox_stopped_at" is null;