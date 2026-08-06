ALTER TABLE "runs" DROP CONSTRAINT "runs_model_connection_id_llm_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_model_connection_id_llm_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_connection_id_llm_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."llm_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_model_connection_id_llm_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."llm_connections"("id") ON DELETE restrict ON UPDATE no action;