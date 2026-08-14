import { createHmac, timingSafeEqual } from "node:crypto";
import type { RepoRef, TaskSpec, Trigger } from "@pi-cloud-agent/protocol";
import { z } from "zod";
import type { IngressAdapter } from "./ingress";
import type { IngressAccept, SurfaceRef } from "./types";
import { surfaceRefSchema } from "./types";

/** Issue-thread surface (ZEN-94 phase 1a). Not PR review comments. */
export const GITHUB_ISSUE_SURFACE_KIND = "github_issue" as const;

const PROMPT_MAX_CHARS = 32_000;

const issueCommentPayloadSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    body: z.string(),
    user: z.object({ login: z.string() }),
  }),
  repository: z.object({
    name: z.string().min(1),
    clone_url: z.string().url(),
    default_branch: z.string().optional(),
    owner: z.object({ login: z.string().min(1) }),
  }),
});

interface GitHubWebhookIngressInput {
  eventHeader: string | null | undefined;
  signatureHeader: string | null | undefined;
  rawBody: string;
}

/**
 * GitHub `issue_comment` → TaskSpec + SurfaceRef.
 *
 * HMAC is GitHub's `X-Hub-Signature-256`. Mentions are `@botLogin`.
 * PR conversation comments (`issue.pull_request` set) wait for a later phase.
 */
export class GitHubIssueCommentAdapter implements IngressAdapter {
  readonly kind = GITHUB_ISSUE_SURFACE_KIND;

  constructor(
    private readonly webhookSecret: string,
    private readonly botLogin: string,
  ) {}

  async accept(input: unknown): Promise<IngressAccept | null> {
    if (!isGitHubWebhookIngressInput(input)) return null;
    if (input.eventHeader !== "issue_comment") return null;
    if (!verifyGitHubSignature(input.rawBody, input.signatureHeader, this.webhookSecret)) {
      return null;
    }

    const payload = parseIssueCommentPayload(input.rawBody);
    if (!payload) return null;
    if (!shouldHandleIssueComment(payload, this.botLogin)) return null;

    const repo = repoFromPayload(payload);
    const prompt = buildIssueMentionPrompt(payload);
    const trigger: Trigger = { kind: "manual", repo, prompt };
    const taskSpec: TaskSpec = { prompt, repo };
    const surface: SurfaceRef = surfaceRefSchema.parse({
      kind: GITHUB_ISSUE_SURFACE_KIND,
      payload: {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issueNumber: payload.issue.number,
      },
    });
    return { trigger, taskSpec, surface };
  }
}

function isGitHubWebhookIngressInput(input: unknown): input is GitHubWebhookIngressInput {
  if (input === null || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return (
    typeof value.rawBody === "string" && "eventHeader" in value && "signatureHeader" in value
  );
}

function parseIssueCommentPayload(rawBody: string) {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = issueCommentPayloadSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function shouldHandleIssueComment(
  payload: z.infer<typeof issueCommentPayloadSchema>,
  botLogin: string,
): boolean {
  if (payload.action !== "created") return false;
  if ("pull_request" in payload.issue && payload.issue.pull_request !== undefined) {
    return false;
  }
  if (payload.comment.user.login.toLowerCase() === botLogin.toLowerCase()) return false;
  return commentMentionsBot(payload.comment.body, botLogin);
}

function commentMentionsBot(body: string, botLogin: string): boolean {
  const escaped = botLogin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)@${escaped}(?=$|\\W)`, "i").test(body);
}

function repoFromPayload(payload: z.infer<typeof issueCommentPayloadSchema>): RepoRef {
  const owner = payload.repository.owner.login;
  const name = payload.repository.name;
  const branch = payload.repository.default_branch ?? "main";
  return {
    provider: "github",
    host: "github.com",
    owner,
    name,
    cloneUrl: payload.repository.clone_url,
    defaultBranch: branch,
    baseSha: "",
    headSha: "",
    headBranch: branch,
    prNumber: null,
  };
}

function buildIssueMentionPrompt(payload: z.infer<typeof issueCommentPayloadSchema>): string {
  const issueBody = payload.issue.body?.trim() || "(no issue body)";
  const text = [
    `GitHub issue #${payload.issue.number}: ${payload.issue.title}`,
    "",
    issueBody,
    "",
    `Comment from @${payload.comment.user.login}:`,
    payload.comment.body,
  ].join("\n");
  if (text.length <= PROMPT_MAX_CHARS) return text;
  return `${text.slice(0, PROMPT_MAX_CHARS)}\n…(truncated)`;
}

function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const actual = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
}
