CREATE TEMP TABLE "llm_connection_merge_v2" (
  "old_id" uuid PRIMARY KEY,
  "new_id" uuid NOT NULL
) ON COMMIT DROP;
--> statement-breakpoint
INSERT INTO "llm_connection_merge_v2" ("old_id", "new_id")
SELECT "id", first_value("id") OVER (
  PARTITION BY "user_id", "display_name", "provider", "auth_type", "api", "base_url"
  ORDER BY "created_at", "id"
)
FROM "llm_connections"
WHERE "auth_type" = 'oauth';
--> statement-breakpoint
WITH "expanded" AS (
  SELECT
    "merge"."new_id",
    "connection"."created_at",
    "connection"."id",
    "model"."value" AS "model",
    row_number() OVER (
      PARTITION BY "merge"."new_id", "model"."value"->>'id'
      ORDER BY "connection"."created_at", "connection"."id"
    ) AS "model_rank"
  FROM "llm_connection_merge_v2" AS "merge"
  JOIN "llm_connections" AS "connection" ON "connection"."id" = "merge"."old_id"
  CROSS JOIN LATERAL jsonb_array_elements("connection"."models") AS "model"("value")
), "merged" AS (
  SELECT "new_id", jsonb_agg("model" ORDER BY "created_at", "id") AS "models"
  FROM "expanded"
  WHERE "model_rank" = 1
  GROUP BY "new_id"
)
UPDATE "llm_connections" AS "connection"
SET "models" = "merged"."models", "updated_at" = now()
FROM "merged"
WHERE "connection"."id" = "merged"."new_id";
--> statement-breakpoint
UPDATE "runs" AS "run"
SET "model_connection_id" = "merge"."new_id"
FROM "llm_connection_merge_v2" AS "merge"
WHERE "run"."model_connection_id" = "merge"."old_id";
--> statement-breakpoint
UPDATE "sessions" AS "session"
SET "model_connection_id" = "merge"."new_id"
FROM "llm_connection_merge_v2" AS "merge"
WHERE "session"."model_connection_id" = "merge"."old_id";
--> statement-breakpoint
DELETE FROM "llm_connections" AS "connection"
USING "llm_connection_merge_v2" AS "merge"
WHERE "connection"."id" = "merge"."old_id"
  AND "merge"."old_id" <> "merge"."new_id";
