import { describe, expect, it } from "vitest";
import { createVcsOAuthProvider } from "./oauth";

const env = {
  GITHUB_APP_CLIENT_ID: "github-client",
  GITHUB_APP_CLIENT_SECRET: "github-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:8080/auth/github/callback",
};

describe("VCS OAuth configuration", () => {
  it("builds a GitHub authorization URL with state and PKCE", () => {
    const provider = createVcsOAuthProvider("github", env);
    const url = new URL(
      provider.authorizationUrl({ state: "state-value", codeChallenge: "challenge-value" }),
    );

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("github-client");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
