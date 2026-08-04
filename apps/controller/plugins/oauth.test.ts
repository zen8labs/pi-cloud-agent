import { describe, expect, it } from "vitest";
import {
  issuerHostAllowed,
  oauthStatusForManifest,
  parsePluginOauth,
  pluginOAuthProvider,
} from "./oauth";

describe("issuerHostAllowed", () => {
  it("accepts allowlisted hosts", () => {
    expect(issuerHostAllowed("https://auth.exa.ai", ["auth.exa.ai"])).toBe(true);
    expect(issuerHostAllowed("https://auth.exa.ai/", ["AUTH.EXA.AI"])).toBe(true);
  });

  it("rejects unknown issuers", () => {
    expect(issuerHostAllowed("https://evil.example", ["auth.exa.ai"])).toBe(false);
    expect(issuerHostAllowed("not-a-url", ["auth.exa.ai"])).toBe(false);
  });
});

describe("parsePluginOauth", () => {
  it("parses a valid oauth block", () => {
    expect(
      parsePluginOauth({
        oauth: {
          resource: "https://mcp.exa.ai/mcp",
          tokenVariable: "EXA_ACCESS_TOKEN",
          scopes: ["mcp:tools"],
        },
      }),
    ).toEqual({
      resource: "https://mcp.exa.ai/mcp",
      tokenVariable: "EXA_ACCESS_TOKEN",
      scopes: ["mcp:tools"],
    });
  });

  it("returns null when oauth is absent or invalid", () => {
    expect(parsePluginOauth({})).toBeNull();
    expect(parsePluginOauth({ oauth: { resource: "not-a-url" } })).toBeNull();
  });
});

describe("oauthStatusForManifest", () => {
  it("exposes connect path when oauth is declared", () => {
    expect(
      oauthStatusForManifest(
        {
          oauth: {
            resource: "https://mcp.exa.ai/mcp",
            tokenVariable: "EXA_ACCESS_TOKEN",
          },
        },
        false,
        "exa",
      ),
    ).toEqual({
      required: true,
      connected: false,
      connectPath: "/plugins/exa/oauth/connect",
      tokenVariable: "EXA_ACCESS_TOKEN",
    });
  });

  it("is inactive when oauth is absent", () => {
    expect(oauthStatusForManifest({}, false, "context7")).toEqual({
      required: false,
      connected: false,
      connectPath: null,
      tokenVariable: null,
    });
  });
});

describe("pluginOAuthProvider", () => {
  it("uses the plugin: prefix for oauth_states", () => {
    expect(pluginOAuthProvider("exa")).toBe("plugin:exa");
  });
});
