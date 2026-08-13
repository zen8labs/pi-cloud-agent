import type { RepoRef, TaskSpec, Trigger } from "@pi-cloud-agent/protocol";
import { z } from "zod";
import type { IngressAdapter } from "./ingress";
import type { ReportSink } from "./report";
import type { IngressAccept, SurfaceRef, SurfaceReport } from "./types";
import { surfaceRefSchema } from "./types";

/** First real surface kind (ZEN-93). Not a forge-specific integration. */
export const REST_WEBHOOK_SURFACE_KIND = "rest_webhook" as const;

const restWebhookBodySchema = z.object({
  provider: z.string().min(1).default("github"),
  /** Provider full name, e.g. `acme/demo`. */
  repo: z.string().min(3),
  prompt: z.string().min(1),
  callbackUrl: z.string().url(),
  branch: z.string().min(1).optional(),
  wallClockSeconds: z.number().int().positive().optional(),
});

/**
 * What the future HTTP route passes into `accept`.
 * Keep headers out of the body so auth stays explicit.
 */
interface RestWebhookIngressInput {
  authorizationHeader: string | null | undefined;
  body: unknown;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Authenticated JSON ingress for CI/cron/internal tools.
 *
 * TODO(wire): HTTP route should resolve `repo` via VCS (like `http/manual.ts`)
 * before `createRun` — `provisionalRepoRef` is only enough for the scaffold.
 * TODO(config): load the bearer secret from `config.ts` (only place that reads env).
 */
export class RestWebhookIngressAdapter implements IngressAdapter {
  readonly kind = REST_WEBHOOK_SURFACE_KIND;

  constructor(private readonly bearerToken: string) {}

  async accept(input: unknown): Promise<IngressAccept | null> {
    if (!isRestWebhookIngressInput(input)) return null;
    if (!bearerMatches(input.authorizationHeader, this.bearerToken)) return null;

    const parsed = restWebhookBodySchema.safeParse(input.body);
    if (!parsed.success) return null;

    const body = parsed.data;
    const repo = provisionalRepoRef(body.provider, body.repo, body.branch);
    if (!repo) return null;

    const trigger: Trigger = { kind: "manual", repo, prompt: body.prompt };
    const taskSpec: TaskSpec = {
      prompt: body.prompt,
      repo,
      wallClockSeconds: body.wallClockSeconds,
    };
    const surface: SurfaceRef = surfaceRefSchema.parse({
      kind: REST_WEBHOOK_SURFACE_KIND,
      payload: { callbackUrl: body.callbackUrl },
    });
    return { trigger, taskSpec, surface };
  }
}

/**
 * POSTs lifecycle reports to the caller-provided callback URL.
 *
 * Failures are swallowed so a dead callback cannot fail the run
 * (ZEN-93 acceptance). Retries / signing / allowlists are TODO.
 */
export class HttpCallbackReportSink implements ReportSink {
  readonly kind = REST_WEBHOOK_SURFACE_KIND;
  /** Soft-failure log for tests / future metrics. */
  readonly failures: string[] = [];

  constructor(private readonly fetchImpl: FetchLike = defaultFetch) {}

  supports(surface: SurfaceRef): boolean {
    return surface.kind === REST_WEBHOOK_SURFACE_KIND;
  }

  async report(surface: SurfaceRef, report: SurfaceReport): Promise<void> {
    const callbackUrl = surface.payload.callbackUrl;
    if (typeof callbackUrl !== "string" || callbackUrl.length === 0) {
      this.failures.push("missing callbackUrl");
      return;
    }

    const payload = {
      runId: report.runId,
      status: report.status,
      terminal: report.terminal,
      detail: report.detail ?? null,
    };

    try {
      const response = await this.fetchImpl(callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        this.failures.push(`callback HTTP ${response.status}`);
      }
    } catch (error) {
      this.failures.push(error instanceof Error ? error.message : String(error));
    }
  }
}

function bearerMatches(
  authorizationHeader: string | null | undefined,
  expectedToken: string,
): boolean {
  if (!authorizationHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1] === expectedToken;
}

function isRestWebhookIngressInput(input: unknown): input is RestWebhookIngressInput {
  if (input === null || typeof input !== "object") return false;
  return "body" in input && "authorizationHeader" in input;
}

/**
 * Best-effort RepoRef so TaskSpec validates in the scaffold.
 * Production must replace this with `vcs.getRepository` + branch resolution.
 */
function provisionalRepoRef(
  provider: string,
  repoFullName: string,
  branch?: string,
): RepoRef | null {
  const [owner, name, ...rest] = repoFullName.split("/");
  if (!owner || !name || rest.length > 0) return null;
  const headBranch = branch ?? "main";
  // TODO(wire): host/cloneUrl must come from the connected VCS provider.
  const host = provider === "azure-devops" ? "dev.azure.com" : "github.com";
  const cloneUrl =
    provider === "azure-devops"
      ? `https://dev.azure.com/${owner}/_git/${name}`
      : `https://github.com/${owner}/${name}.git`;
  return {
    provider,
    host,
    owner,
    name,
    cloneUrl,
    defaultBranch: headBranch,
    baseSha: "",
    headSha: "",
    headBranch,
    prNumber: null,
  };
}

async function defaultFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status };
}
