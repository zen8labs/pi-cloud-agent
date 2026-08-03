CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vcs_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"account_name" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oauth_states_expiry_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vcs_connections_provider_idx" ON "vcs_connections" USING btree ("provider");