CREATE TABLE "github_review_repositories" (
	"installation_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"auto_review" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_review_repositories_installation_id_repo_full_name_pk" PRIMARY KEY("installation_id","repo_full_name")
);
--> statement-breakpoint
ALTER TABLE "github_review_repositories" ADD CONSTRAINT "github_review_repositories_installation_id_github_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("installation_id") ON DELETE cascade ON UPDATE no action;