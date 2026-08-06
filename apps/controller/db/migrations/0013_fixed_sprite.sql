CREATE TABLE "plugin_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"plugin_name" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_oauth_tokens" (
	"user_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"access_encrypted" text NOT NULL,
	"refresh_encrypted" text,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_oauth_tokens_user_id_plugin_id_pk" PRIMARY KEY("user_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_settings" (
	"plugin_id" uuid PRIMARY KEY NOT NULL,
	"install_mode" text DEFAULT 'default_off' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_user_state" (
	"user_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"override" text,
	"installed_version_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_user_state_user_id_plugin_id_pk" PRIMARY KEY("user_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_user_variables" (
	"user_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"name" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_user_variables_user_id_plugin_id_name_pk" PRIMARY KEY("user_id","plugin_id","name")
);
--> statement-breakpoint
CREATE TABLE "plugin_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"artifact_path" text NOT NULL,
	"components" jsonb DEFAULT '{"skills":false,"mcp":false}'::jsonb NOT NULL,
	"review_status" text DEFAULT 'draft' NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"publisher" text DEFAULT 'Zen8' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "plugins" jsonb;--> statement-breakpoint
ALTER TABLE "plugin_audit_log" ADD CONSTRAINT "plugin_audit_log_actor_user_id_app_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_oauth_tokens" ADD CONSTRAINT "plugin_oauth_tokens_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_oauth_tokens" ADD CONSTRAINT "plugin_oauth_tokens_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_settings" ADD CONSTRAINT "plugin_settings_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_user_state" ADD CONSTRAINT "plugin_user_state_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_user_state" ADD CONSTRAINT "plugin_user_state_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_user_state" ADD CONSTRAINT "plugin_user_state_installed_version_id_plugin_versions_id_fk" FOREIGN KEY ("installed_version_id") REFERENCES "public"."plugin_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_user_variables" ADD CONSTRAINT "plugin_user_variables_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_user_variables" ADD CONSTRAINT "plugin_user_variables_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_versions" ADD CONSTRAINT "plugin_versions_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_audit_log_created_idx" ON "plugin_audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_oauth_clients_issuer_redirect_idx" ON "plugin_oauth_clients" USING btree ("issuer","redirect_uri");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_versions_plugin_version_idx" ON "plugin_versions" USING btree ("plugin_id","version");--> statement-breakpoint
CREATE INDEX "plugin_versions_status_idx" ON "plugin_versions" USING btree ("review_status");--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_name_idx" ON "plugins" USING btree ("name");