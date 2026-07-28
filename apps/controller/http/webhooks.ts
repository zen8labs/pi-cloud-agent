import { randomBytes } from "node:crypto";
import { listProfiles } from "@pi-cloud-agent/profiles";
import {
  type Profile,
  repoFullName,
  type Trigger,
  type VCSProvider,
  WebhookVerificationError,
} from "@pi-cloud-agent/protocol";
import { createVcsProvider } from "@pi-cloud-agent/vcs";
import { Hono } from "hono";
import type { Database } from "../db/client";
import { getRepoConfig } from "../db/repo-config";
import { createRun } from "../db/runs";
import type { Logger } from "../logger";
import type { AppEnv } from "./deps";

/**
 * Webhook intake.
 *
 * Three steps: authenticate, normalize, then ask every profile whether it wants
 * the result. That last step is why this file contains no mention of pull request
 * review — the controller does not decide which profile handles which event.
 * A new profile that accepts `pr_opened` starts receiving runs with no change
 * here, and a profile whose per-repo config disables a trigger simply declines.
 */
export function webhookRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/:provider", async (c) => {
    const providerName = c.req.param("provider");
    const config = c.get("config");
    const log = c.get("log").child({ provider: providerName });

    let vcs: ReturnType<typeof createVcsProvider>;
    try {
      vcs = createVcsProvider(providerName, config.env);
    } catch {
      return c.json({ error: `unknown provider "${providerName}"` }, 404);
    }

    // Read the raw body: signature verification has to run over exactly the
    // bytes that were sent, not a re-serialized object.
    const body = await c.req.text();

    let trigger: Trigger | null;
    try {
      trigger = vcs.verifyAndParseWebhook(c.req.raw.headers, body);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        log.warn("webhook rejected", { error });
        return c.json({ error: "invalid webhook signature" }, 401);
      }
      throw error;
    }

    // Understood, nothing to do. Not an error, and it must not look like one.
    if (!trigger) return c.body(null, 204);

    const database = c.get("database");
    const fullName = repoFullName(trigger.repo);

    const enriched = await enrich(trigger, vcs, log);
    const started = await fanOut(enriched, {
      database,
      providerName,
      fullName,
      model: config.model.id,
      log,
    });

    if (started.length === 0) return c.body(null, 204);
    return c.json({ runs: started }, 202);
  });

  return app;
}

/**
 * Fill in commit coordinates a webhook did not carry.
 *
 * GitHub's `issue_comment` has no SHAs, and the sandbox has to clone an exact
 * revision. Doing this once, here, keeps the stored trigger complete — which is
 * what makes a run reproducible from its row alone. A lookup failure is not
 * fatal: the runtime falls back to the tip of the branch.
 */
async function enrich(trigger: Trigger, vcs: VCSProvider, log: Logger): Promise<Trigger> {
  if (trigger.repo.prNumber === null || trigger.repo.headSha) return trigger;
  try {
    return {
      ...trigger,
      repo: await vcs.resolvePullRequest(trigger.repo, trigger.repo.prNumber),
    };
  } catch (error) {
    log.warn("could not resolve pull request coordinates", {
      repo: repoFullName(trigger.repo),
      error,
    });
    return trigger;
  }
}

/** Start a run for every profile that accepts this trigger. */
async function fanOut(
  trigger: Trigger,
  context: {
    database: Database;
    providerName: string;
    fullName: string;
    model: string;
    log: Logger;
  },
): Promise<string[]> {
  const { database, providerName, fullName, model, log } = context;
  const started: string[] = [];

  for (const profile of listProfiles()) {
    if (!(await wantsTrigger(profile, trigger, context))) continue;

    const run = await createRun(database, {
      profile: profile.name,
      provider: providerName,
      repoFullName: fullName,
      trigger,
      model,
      callbackToken: randomBytes(32).toString("hex"),
    });
    started.push(run.id);
    log.info("run queued from webhook", {
      runId: run.id,
      profile: profile.name,
      repo: fullName,
      kind: trigger.kind,
    });
  }

  return started;
}

/**
 * Ask one profile whether it wants this trigger, using that repo's stored config.
 *
 * A profile whose stored config no longer parses is skipped rather than allowed
 * to fail the whole delivery: one bad settings row must not stop every other
 * profile from running.
 */
async function wantsTrigger(
  profile: Profile,
  trigger: Trigger,
  context: {
    database: Database;
    providerName: string;
    fullName: string;
    log: Logger;
  },
): Promise<boolean> {
  const { database, providerName, fullName, log } = context;
  try {
    const storedConfig = await getRepoConfig(database, {
      provider: providerName,
      repoFullName: fullName,
      profile: profile.name,
    });
    return profile.accepts(trigger, storedConfig);
  } catch (error) {
    log.error("profile rejected its own stored config", { profile: profile.name, error });
    return false;
  }
}
