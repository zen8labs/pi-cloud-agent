import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubInstallationId, projectGithubEvent, verifyGithubSignature } from "./github";

describe("GitHub webhook boundary", () => {
  it("reads numeric installation ids from webhook payloads", () => {
    expect(githubInstallationId({ installation: { id: 153588170 } })).toBe("153588170");
    expect(githubInstallationId({ installation: { id: "153588170" } })).toBeNull();
  });

  it("accepts only the HMAC for the raw request body", () => {
    const body = JSON.stringify({ action: "ping" });
    const secret = "test-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(verifyGithubSignature(body, signature, secret)).toBe(true);
    expect(verifyGithubSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyGithubSignature(body, "sha256=wrong", secret)).toBe(false);
  });

  it("pins a review projection to the fork head and base revision", () => {
    const projection = projectGithubEvent(
      {
        action: "opened",
        number: 42,
        repository: { full_name: "acme/widgets" },
        pull_request: {
          title: "Add the review seam",
          body: "Please review this change.",
          base: {
            ref: "main",
            sha: "base-sha",
            repo: { full_name: "acme/widgets" },
          },
          head: {
            ref: "feature/reviews",
            sha: "head-sha",
            repo: {
              full_name: "contributor/widgets",
              clone_url: "https://github.com/contributor/widgets.git",
            },
          },
        },
      },
      "pull_request",
      "@pi-cloud-agent",
    );

    expect(projection).toMatchObject({
      intent: "github_review",
      externalThreadKey: "github:pr:acme/widgets:42",
      repo: {
        owner: "acme",
        name: "widgets",
        cloneUrl: "https://github.com/contributor/widgets.git",
        baseCloneUrl: "https://github.com/acme/widgets.git",
        defaultBranch: "main",
        baseSha: "base-sha",
        headSha: "head-sha",
        headBranch: "feature/reviews",
        prNumber: 42,
      },
    });
  });

  it("ignores unmentioned follow-up comments", () => {
    expect(
      projectGithubEvent(
        {
          action: "created",
          issue: {
            number: 42,
            pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/42" },
          },
          comment: { body: "Not delegated" },
          repository: { full_name: "acme/widgets" },
        },
        "issue_comment",
        "@pi-cloud-agent",
      ),
    ).toBeNull();
  });

  it("matches GitHub handles case-insensitively", () => {
    expect(
      projectGithubEvent(
        {
          action: "created",
          issue: {
            number: 42,
            pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/42" },
          },
          comment: { id: 123, body: "@PI-CLOUD-AGENT please summarize" },
          repository: { full_name: "acme/widgets" },
        },
        "issue_comment",
        "@pi-cloud-agent",
      ),
    ).toMatchObject({ intent: "github_task", externalMessageId: "123" });
  });

  it("does not match a longer handle that merely starts with the configured mention", () => {
    expect(
      projectGithubEvent(
        {
          action: "created",
          issue: {
            number: 42,
            pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/42" },
          },
          comment: { body: "@pi-cloud-agent-helper please summarize" },
          repository: { full_name: "acme/widgets" },
        },
        "issue_comment",
        "@pi-cloud-agent",
      ),
    ).toBeNull();
  });

  it("retains the triggering comment target for a structured reply", () => {
    expect(
      projectGithubEvent(
        {
          action: "created",
          issue: {
            number: 42,
            pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/42" },
          },
          comment: {
            id: 123,
            body: "@pi-cloud-agent please summarize",
            user: { login: "alice" },
          },
          repository: { full_name: "acme/widgets" },
        },
        "issue_comment",
        "@pi-cloud-agent",
      ),
    ).toMatchObject({
      intent: "github_task",
      externalMessageId: "123",
      externalActor: "alice",
    });
  });
});
