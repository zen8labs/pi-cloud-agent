CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" text NOT NULL,
	"login" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "vcs_connections_provider_idx";--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "vcs_connections" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_github_user_idx" ON "app_users" USING btree ("github_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_sessions_token_hash_idx" ON "web_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "web_sessions_user_expiry_idx" ON "web_sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
INSERT INTO "app_users" ("github_user_id", "login", "display_name")
SELECT "account_id", "account_name", "account_name"
FROM "vcs_connections"
WHERE "provider" = 'github'
ON CONFLICT ("github_user_id") DO NOTHING;--> statement-breakpoint
UPDATE "vcs_connections" AS connections
SET "user_id" = users."id"
FROM "app_users" AS users
WHERE connections."provider" = 'github'
  AND users."github_user_id" = connections."account_id";--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_connections" ADD CONSTRAINT "vcs_connections_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_connections_user_provider_idx" ON "vcs_connections" USING btree ("user_id","provider");
