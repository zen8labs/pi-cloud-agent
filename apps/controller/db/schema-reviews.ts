import {
  type AnyPgColumn,
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export function defineReviewRepositories(installationReference: () => AnyPgColumn) {
  /** Explicit opt-in for automatic reviews; absence means disabled. */
  return pgTable(
    "github_review_repositories",
    {
      installationId: text("installation_id")
        .notNull()
        .references(installationReference, { onDelete: "cascade" }),
      repoFullName: text("repo_full_name").notNull(),
      autoReview: boolean("auto_review").notNull().default(false),
      updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    },
    (table) => [primaryKey({ columns: [table.installationId, table.repoFullName] })],
  );
}
