import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GITHUB_ISSUE_SURFACE_KIND, GitHubIssueCommentAdapter } from "./index";

const SECRET = "github-webhook-secret";
const BOT = "pi-cloud-bot";

function sign(rawBody: string): string {
  const digest = createHmac("sha256", SECRET).update(rawBody).digest("hex");
  return `sha256=${digest}`;
}

function issueCommentPayload(
  overrides: {
    action?: string;
    commentBody?: string;
    commentLogin?: string;
    issueBody?: string | null;
    pullRequest?: boolean;
  } = {},
): string {
  const issue: Record<string, unknown> = {
    number: 42,
    title: "Flaky tests in CI",
    body: overrides.issueBody === undefined ? "The suite fails on main." : overrides.issueBody,
  };
  if (overrides.pullRequest)
    issue.pull_request = { url: "https://api.github.com/repos/acme/demo/pulls/42" };
  return JSON.stringify({
    action: overrides.action ?? "created",
    issue,
    comment: {
      body: overrides.commentBody ?? `@${BOT} please fix the flaky tests`,
      user: { login: overrides.commentLogin ?? "alice" },
    },
    repository: {
      name: "demo",
      clone_url: "https://github.com/acme/demo.git",
      default_branch: "main",
      owner: { login: "acme" },
    },
  });
}

function ingress(rawBody: string, headers: { event?: string; signature?: string | null } = {}) {
  return {
    eventHeader: headers.event ?? "issue_comment",
    signatureHeader: headers.signature === undefined ? sign(rawBody) : headers.signature,
    rawBody,
  };
}

describe("ZEN-94 1a GitHub issue comment adapter", () => {
  const adapter = new GitHubIssueCommentAdapter(SECRET, BOT);

  it("accepts a signed issue comment that @mentions the bot", async () => {
    const rawBody = issueCommentPayload();
    const accepted = await adapter.accept(ingress(rawBody));
    expect(accepted).not.toBeNull();
    expect(accepted?.taskSpec.repo.owner).toBe("acme");
    expect(accepted?.taskSpec.repo.name).toBe("demo");
    expect(accepted?.taskSpec.prompt).toContain("Flaky tests in CI");
    expect(accepted?.taskSpec.prompt).toContain("@pi-cloud-bot please fix");
    expect(accepted?.trigger.kind).toBe("manual");
    expect(accepted?.surface).toEqual({
      kind: GITHUB_ISSUE_SURFACE_KIND,
      payload: { owner: "acme", repo: "demo", issueNumber: 42 },
    });
  });

  it("rejects a bad or missing HMAC", async () => {
    const rawBody = issueCommentPayload();
    expect(await adapter.accept(ingress(rawBody, { signature: "sha256=deadbeef" }))).toBeNull();
    expect(await adapter.accept(ingress(rawBody, { signature: null }))).toBeNull();
  });

  it("ignores other GitHub events, non-created actions, and PR issue threads", async () => {
    const mention = issueCommentPayload();
    expect(await adapter.accept(ingress(mention, { event: "push" }))).toBeNull();
    expect(await adapter.accept(ingress(issueCommentPayload({ action: "edited" })))).toBeNull();
    expect(
      await adapter.accept(ingress(issueCommentPayload({ pullRequest: true }))),
    ).toBeNull();
  });

  it("ignores comments that do not mention the bot, and the bot's own comments", async () => {
    expect(
      await adapter.accept(ingress(issueCommentPayload({ commentBody: "anyone there?" }))),
    ).toBeNull();
    expect(
      await adapter.accept(
        ingress(issueCommentPayload({ commentLogin: BOT, commentBody: `@${BOT} looping` })),
      ),
    ).toBeNull();
  });
});
