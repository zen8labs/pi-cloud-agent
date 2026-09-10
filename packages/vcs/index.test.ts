import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGithubCommentPublisher,
  createGithubInstallationToken,
  createVcsProvider,
  vcsProviderNames,
  verifyGithubInstallation,
} from "./index";

afterEach(() => vi.unstubAllGlobals());

describe("provider registry", () => {
  it("lists the alternatives when asked for one that does not exist", () => {
    expect(() => createVcsProvider("perforce", "")).toThrow(
      /Unknown VCS provider "perforce".*azure-devops, github/s,
    );
  });

  it("lists the providers it can build", () => {
    expect(vcsProviderNames()).toEqual(["azure-devops", "github"]);
  });

  it("verifies installations from the user-accessible installation list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          installations: [
            { id: 153583609, app_id: 3738122, account: { id: 42, login: "acme" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyGithubInstallation("token", "153583609")).resolves.toEqual({
      id: "153583609",
      appId: "3738122",
      accountId: "42",
      accountLogin: "acme",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/user/installations?per_page=100&page=1",
    );
  });

  it("continues through installation-list pages", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      app_id: 3738122,
      account: { id: 42, login: "acme" },
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ installations: firstPage }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            installations: [
              { id: 153583609, app_id: 3738122, account: { id: 42, login: "acme" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyGithubInstallation("token", "153583609")).resolves.toMatchObject({
      id: "153583609",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/user/installations?per_page=100&page=2",
    );
  });

  it("rejects an installation owned by a different GitHub App", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            installations: [{ id: 99, app_id: 123, account: { id: 42, login: "acme" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(verifyGithubInstallation("token", "99", "3738122")).resolves.toBeNull();
  });

  it("publishes a task reply to the triggering issue comment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 99 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createGithubCommentPublisher("installation-token").submitComment({
        owner: "acme",
        repo: "widgets",
        issueNumber: 42,
        commentId: "123",
        replyKind: "issue_comment",
        body: "Done",
      }),
    ).resolves.toEqual({ id: "99" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/widgets/issues/42/comments",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ body: "Done" });
  });

  it("uses the review-comment reply endpoint for inline discussions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 100 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createGithubCommentPublisher("installation-token").submitComment({
      owner: "acme",
      repo: "widgets",
      issueNumber: 42,
      commentId: "456",
      replyKind: "review_comment",
      body: "Inline answer",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/widgets/pulls/42/comments/456/replies",
    );
  });

  it("mints an installation token with a short-lived app JWT", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: "installation-token", expires_at: "tomorrow" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createGithubInstallationToken(
        {
          appId: "3738122",
          privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        },
        "153588170",
        "acme/widgets",
      ),
    ).resolves.toEqual({ token: "installation-token", expiresAt: "tomorrow" });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const authorization = String(new Headers(request.headers).get("authorization"));
    expect(new Headers(request.headers).get("content-type")).toBe("application/json");
    const jwt = authorization.replace("Bearer ", "").split(".");
    expect(jwt).toHaveLength(3);
    expect(JSON.parse(Buffer.from(jwt[1] ?? "", "base64url").toString())).toMatchObject({
      iss: "3738122",
    });
    expect(JSON.parse(String(request.body))).toEqual({
      repositories: ["widgets"],
      permissions: { contents: "write", pull_requests: "write" },
    });
  });
});
