import { createHmac } from "node:crypto";
import { WebhookVerificationError } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import { createVcsProvider } from "./index";

/**
 * Webhook intake is the one place an unauthenticated stranger can reach, so
 * these tests care about two things above all: that a forged or unverifiable
 * request is refused, and that an event we understand becomes exactly the right
 * trigger. The refusal cases matter more than the happy paths.
 */

const SECRET = "shhh-webhook-secret";

const env = {
  GITHUB_WEBHOOK_SECRET: SECRET,
  GITHUB_TOKEN: "gho_test_token_value",
  GITLAB_WEBHOOK_SECRET: SECRET,
  GITLAB_TOKEN: "glpat-test",
  BITBUCKET_WEBHOOK_SECRET: SECRET,
  BITBUCKET_TOKEN: "bb-test",
};

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("github webhooks", () => {
  const github = createVcsProvider("github", env);

  const pullRequestBody = JSON.stringify({
    action: "opened",
    repository: {
      name: "widgets",
      owner: { login: "acme" },
      html_url: "https://github.com/acme/widgets",
      clone_url: "https://github.com/acme/widgets.git",
      default_branch: "main",
    },
    pull_request: {
      number: 7,
      head: { sha: "headsha", ref: "feature" },
      base: { sha: "basesha" },
    },
  });

  it("normalizes an opened pull request into a trigger", () => {
    const trigger = github.verifyAndParseWebhook(
      headers({
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(pullRequestBody),
      }),
      pullRequestBody,
    );
    expect(trigger).toEqual({
      kind: "pr_opened",
      repo: {
        provider: "github",
        host: "github.com",
        owner: "acme",
        name: "widgets",
        cloneUrl: "https://github.com/acme/widgets.git",
        defaultBranch: "main",
        baseSha: "basesha",
        headSha: "headsha",
        headBranch: "feature",
        prNumber: 7,
      },
    });
  });

  it("rejects a forged signature", () => {
    expect(() =>
      github.verifyAndParseWebhook(
        headers({
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign("other body"),
        }),
        pullRequestBody,
      ),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects a request with no signature at all", () => {
    expect(() =>
      github.verifyAndParseWebhook(
        headers({ "x-github-event": "pull_request" }),
        pullRequestBody,
      ),
    ).toThrow(WebhookVerificationError);
  });

  it("refuses to accept anything when no secret is configured", () => {
    // Fails closed: "we cannot verify" must never take the same branch as
    // "this is authentic".
    const unconfigured = createVcsProvider("github", { GITHUB_TOKEN: "t" });
    expect(() =>
      unconfigured.verifyAndParseWebhook(
        headers({
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign(pullRequestBody),
        }),
        pullRequestBody,
      ),
    ).toThrow(WebhookVerificationError);
  });

  it("verifies before parsing, so a bad body never reaches JSON handling", () => {
    expect(() =>
      github.verifyAndParseWebhook(
        headers({ "x-github-event": "pull_request", "x-hub-signature-256": "sha256=deadbeef" }),
        "{ not json",
      ),
    ).toThrow(WebhookVerificationError);
  });

  it("maps reopened to opened and synchronize to updated", () => {
    for (const [action, kind] of [
      ["reopened", "pr_opened"],
      ["synchronize", "pr_updated"],
    ] as const) {
      const body = pullRequestBody.replace('"action":"opened"', `"action":"${action}"`);
      const trigger = github.verifyAndParseWebhook(
        headers({ "x-github-event": "pull_request", "x-hub-signature-256": sign(body) }),
        body,
      );
      expect(trigger?.kind).toBe(kind);
    }
  });

  it("treats a pull request comment as a command, without commit coordinates", () => {
    const body = JSON.stringify({
      action: "created",
      repository: { name: "widgets", owner: { login: "acme" } },
      issue: { number: 9, pull_request: { url: "https://api.github.com/…" } },
      comment: { body: "/review please" },
    });
    const trigger = github.verifyAndParseWebhook(
      headers({ "x-github-event": "issue_comment", "x-hub-signature-256": sign(body) }),
      body,
    );
    expect(trigger?.kind).toBe("pr_comment");
    expect(trigger?.command).toBe("/review please");
    expect(trigger?.repo.prNumber).toBe(9);
    // The controller enriches these before a sandbox needs an exact revision.
    expect(trigger?.repo.headSha).toBe("");
  });

  it("ignores comments on plain issues and actions it does not handle", () => {
    const issueComment = JSON.stringify({
      action: "created",
      repository: { name: "widgets", owner: { login: "acme" } },
      issue: { number: 9 },
      comment: { body: "/review" },
    });
    expect(
      github.verifyAndParseWebhook(
        headers({
          "x-github-event": "issue_comment",
          "x-hub-signature-256": sign(issueComment),
        }),
        issueComment,
      ),
    ).toBeNull();

    const closed = pullRequestBody.replace('"action":"opened"', '"action":"closed"');
    expect(
      github.verifyAndParseWebhook(
        headers({ "x-github-event": "pull_request", "x-hub-signature-256": sign(closed) }),
        closed,
      ),
    ).toBeNull();

    expect(
      github.verifyAndParseWebhook(
        headers({ "x-github-event": "star", "x-hub-signature-256": sign(pullRequestBody) }),
        pullRequestBody,
      ),
    ).toBeNull();
  });

  it("reads the host from the payload, so Enterprise installs resolve correctly", () => {
    const body = pullRequestBody.replace(
      "https://github.com/acme/widgets",
      "https://git.acme.io/acme/widgets",
    );
    const trigger = github.verifyAndParseWebhook(
      headers({ "x-github-event": "pull_request", "x-hub-signature-256": sign(body) }),
      body,
    );
    expect(trigger?.repo.host).toBe("git.acme.io");
  });
});

describe("gitlab webhooks", () => {
  const gitlab = createVcsProvider("gitlab", env);
  const project = {
    path_with_namespace: "acme/widgets",
    web_url: "https://gitlab.com/acme/widgets",
    git_http_url: "https://gitlab.com/acme/widgets.git",
    default_branch: "main",
  };

  it("accepts a matching shared token and normalizes a merge request", () => {
    const body = JSON.stringify({
      object_kind: "merge_request",
      project,
      object_attributes: {
        action: "open",
        iid: 5,
        source_branch: "feature",
        last_commit: { id: "headsha" },
        base_commit_sha: "basesha",
      },
    });
    const trigger = gitlab.verifyAndParseWebhook(headers({ "x-gitlab-token": SECRET }), body);
    expect(trigger?.kind).toBe("pr_opened");
    expect(trigger?.repo.prNumber).toBe(5);
    expect(trigger?.repo.owner).toBe("acme");
    expect(trigger?.repo.headSha).toBe("headsha");
  });

  it("rejects a wrong or missing token", () => {
    const body = JSON.stringify({
      object_kind: "merge_request",
      project,
      object_attributes: {},
    });
    expect(() =>
      gitlab.verifyAndParseWebhook(headers({ "x-gitlab-token": "wrong" }), body),
    ).toThrow(WebhookVerificationError);
    expect(() => gitlab.verifyAndParseWebhook(headers({}), body)).toThrow(
      WebhookVerificationError,
    );
  });

  it("only treats an update with new commits as an update", () => {
    // GitLab fires `update` for label and description edits too; a changed
    // `oldrev` is the only signal that code actually moved.
    const withCommits = JSON.stringify({
      object_kind: "merge_request",
      project,
      object_attributes: { action: "update", oldrev: "abc", iid: 5 },
    });
    const metadataOnly = JSON.stringify({
      object_kind: "merge_request",
      project,
      object_attributes: { action: "update", iid: 5 },
    });
    expect(
      gitlab.verifyAndParseWebhook(headers({ "x-gitlab-token": SECRET }), withCommits)?.kind,
    ).toBe("pr_updated");
    expect(
      gitlab.verifyAndParseWebhook(headers({ "x-gitlab-token": SECRET }), metadataOnly),
    ).toBeNull();
  });
});

describe("bitbucket webhooks", () => {
  const bitbucket = createVcsProvider("bitbucket", env);
  const body = JSON.stringify({
    repository: { full_name: "acme/widgets", mainbranch: { name: "main" } },
    pullrequest: {
      id: 3,
      source: { commit: { hash: "headsha" }, branch: { name: "feature" } },
      destination: { commit: { hash: "basesha" } },
    },
  });

  it("accepts an HMAC signature when the workspace sends one", () => {
    const trigger = bitbucket.verifyAndParseWebhook(
      headers({ "x-event-key": "pullrequest:created", "x-hub-signature": sign(body) }),
      body,
    );
    expect(trigger?.kind).toBe("pr_opened");
    expect(trigger?.repo.prNumber).toBe(3);
  });

  it("falls back to a shared secret header, since Bitbucket does not always sign", () => {
    const trigger = bitbucket.verifyAndParseWebhook(
      headers({ "x-event-key": "pullrequest:updated", "x-hook-secret": SECRET }),
      body,
    );
    expect(trigger?.kind).toBe("pr_updated");
  });

  it("rejects a request carrying neither proof", () => {
    expect(() =>
      bitbucket.verifyAndParseWebhook(headers({ "x-event-key": "pullrequest:created" }), body),
    ).toThrow(WebhookVerificationError);
  });
});

describe("provider registry", () => {
  it("lists the alternatives when asked for one that does not exist", () => {
    expect(() => createVcsProvider("perforce", env)).toThrow(
      /Unknown VCS provider "perforce".*bitbucket, github, gitlab/s,
    );
  });
});
