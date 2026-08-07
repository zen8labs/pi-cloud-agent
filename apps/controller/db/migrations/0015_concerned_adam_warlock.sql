CREATE TABLE "observability_exports" (
	"run_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"exported_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_exports_run_id_destination_pk" PRIMARY KEY("run_id","destination")
);
--> statement-breakpoint
ALTER TABLE "observability_exports" ADD CONSTRAINT "observability_exports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observability_exports_pending_idx" ON "observability_exports" USING btree ("destination","status","updated_at");