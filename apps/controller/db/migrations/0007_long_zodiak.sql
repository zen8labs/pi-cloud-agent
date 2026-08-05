CREATE TABLE "llm_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"provider" text NOT NULL,
	"auth_type" text NOT NULL,
	"api" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"context_window" integer NOT NULL,
	"max_tokens" integer NOT NULL,
	"credential" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_connections" ADD CONSTRAINT "llm_connections_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_connections_user_updated_idx" ON "llm_connections" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_connection_id_llm_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."llm_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_model_connection_id_llm_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."llm_connections"("id") ON DELETE set null ON UPDATE no action;