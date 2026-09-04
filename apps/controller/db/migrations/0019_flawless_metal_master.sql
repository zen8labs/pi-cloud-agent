CREATE TABLE "github_comment_publications" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"submission" jsonb NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"github_comment_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_comment_publications" ADD CONSTRAINT "github_comment_publications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;