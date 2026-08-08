CREATE TABLE "repository_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"setup_script" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repository_environments" ADD CONSTRAINT "repository_environments_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repository_environments_user_repo_idx" ON "repository_environments" USING btree ("user_id","provider","repo_full_name");--> statement-breakpoint
CREATE INDEX "repository_environments_user_updated_idx" ON "repository_environments" USING btree ("user_id","updated_at" DESC NULLS LAST);