ALTER TABLE "runs" ADD COLUMN "integration_provider" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "integration_delivery_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_integration_delivery_idx" ON "runs" USING btree ("integration_provider","integration_delivery_id");