ALTER TABLE "llm_connections" ADD COLUMN "models" jsonb;
--> statement-breakpoint
UPDATE "llm_connections"
SET "models" = jsonb_build_array(
  jsonb_build_object(
    'id', "model",
    'baseUrl', "base_url",
    'contextWindow', "context_window",
    'maxTokens', "max_tokens"
  )
);
--> statement-breakpoint
CREATE TEMP TABLE "llm_connection_merge" (
  "old_id" uuid PRIMARY KEY,
  "new_id" uuid NOT NULL
) ON COMMIT DROP;
--> statement-breakpoint
INSERT INTO "llm_connection_merge" ("old_id", "new_id")
SELECT "id", first_value("id") OVER (
  PARTITION BY "user_id", "display_name", "provider", "auth_type", "api", "base_url", "credential"
  ORDER BY "created_at", "id"
)
FROM "llm_connections"
WHERE "auth_type" = 'oauth';
--> statement-breakpoint
WITH "merged" AS (
  SELECT
    "merge"."new_id",
    jsonb_agg(
      jsonb_build_object(
        'id', "connection"."model",
        'baseUrl', "connection"."base_url",
        'contextWindow', "connection"."context_window",
        'maxTokens', "connection"."max_tokens"
      ) ORDER BY "connection"."created_at", "connection"."id"
    ) AS "models"
  FROM "llm_connection_merge" AS "merge"
  JOIN "llm_connections" AS "connection" ON "connection"."id" = "merge"."old_id"
  GROUP BY "merge"."new_id"
)
UPDATE "llm_connections" AS "connection"
SET
  "models" = "merged"."models",
  "model" = "merged"."models"->0->>'id',
  "context_window" = ("merged"."models"->0->>'contextWindow')::integer,
  "max_tokens" = ("merged"."models"->0->>'maxTokens')::integer,
  "updated_at" = now()
FROM "merged"
WHERE "connection"."id" = "merged"."new_id";
--> statement-breakpoint
UPDATE "runs" AS "run"
SET "model_connection_id" = "merge"."new_id"
FROM "llm_connection_merge" AS "merge"
WHERE "run"."model_connection_id" = "merge"."old_id";
--> statement-breakpoint
UPDATE "sessions" AS "session"
SET "model_connection_id" = "merge"."new_id"
FROM "llm_connection_merge" AS "merge"
WHERE "session"."model_connection_id" = "merge"."old_id";
--> statement-breakpoint
DELETE FROM "llm_connections" AS "connection"
USING "llm_connection_merge" AS "merge"
WHERE "connection"."id" = "merge"."old_id"
  AND "merge"."old_id" <> "merge"."new_id";
--> statement-breakpoint
ALTER TABLE "llm_connections" ALTER COLUMN "models" SET NOT NULL;
