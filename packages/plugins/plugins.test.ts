import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPluginPackage, toCatalogVersion } from "./load";
import { assertCommandAllowlist, substituteVariables } from "./mcp";
import { resolvePackagePath } from "./paths";
import { composePrompt, composeSkillText, resolveEffectivePlugins } from "./resolve";
import type { CatalogPluginVersion, PluginSettings, PluginUserState } from "./types";

describe("resolvePackagePath", () => {
  it("rejects absolute paths and traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-"));
    expect(() => resolvePackagePath(root, "/etc/passwd")).toThrow(/relative/);
    expect(() => resolvePackagePath(root, "../outside")).toThrow(/\.\./);
  });

  it("resolves a safe relative path", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-"));
    expect(resolvePackagePath(root, "mcp.json")).toBe(join(root, "mcp.json"));
  });
});

describe("resolveEffectivePlugins", () => {
  const catalog: CatalogPluginVersion[] = [
    baseVersion("alpha"),
    baseVersion("beta"),
    { ...baseVersion("yanked"), reviewStatus: "yanked" },
  ];

  it("attaches Required regardless of user override", () => {
    const settings: PluginSettings[] = [{ name: "alpha", installMode: "required" }];
    const users: PluginUserState[] = [
      { name: "alpha", override: "disabled", installed: false },
    ];
    expect(resolveEffectivePlugins(catalog, settings, users).map((p) => p.name)).toEqual([
      "alpha",
    ]);
  });

  it("lets the user opt out of Default On", () => {
    const settings: PluginSettings[] = [{ name: "alpha", installMode: "default_on" }];
    const users: PluginUserState[] = [{ name: "alpha", override: "disabled", installed: true }];
    expect(resolveEffectivePlugins(catalog, settings, users)).toEqual([]);
  });

  it("attaches Default Off only when installed/enabled", () => {
    const settings: PluginSettings[] = [{ name: "alpha", installMode: "default_off" }];
    expect(resolveEffectivePlugins(catalog, settings, [])).toEqual([]);
    expect(
      resolveEffectivePlugins(catalog, settings, [
        { name: "alpha", override: null, installed: true },
      ]).map((p) => p.name),
    ).toEqual(["alpha"]);
  });

  it("skips yanked versions", () => {
    const settings: PluginSettings[] = [{ name: "yanked", installMode: "required" }];
    expect(resolveEffectivePlugins(catalog, settings, [])).toEqual([]);
  });
});

describe("composeSkillText", () => {
  it("replaces the profile skill when plugins contribute skills", () => {
    const text = composeSkillText(
      [
        {
          ...effective("context7"),
          skillTexts: ["plugin skill A"],
        },
      ],
      "profile skill",
    );
    expect(text).toBe("plugin skill A");
    expect(text).not.toContain("profile skill");
  });

  it("falls back to the profile skill when no plugin skills", () => {
    expect(composeSkillText([effective("mcp-only")], "profile skill")).toBe("profile skill");
    expect(composeSkillText([], undefined)).toBeUndefined();
  });

  it("composePrompt prepends skill when present", () => {
    expect(composePrompt("skill", "do it")).toBe("skill\n\n---\n\ndo it");
    expect(composePrompt(undefined, "do it")).toBe("do it");
  });
});

describe("MCP substitution and allowlist", () => {
  it("substitutes variables and rejects missing ones", () => {
    const placeholder = ["$", "{", "CONTEXT7_API_KEY", "}"].join("");
    const config = {
      mcpServers: {
        context7: {
          url: "https://mcp.context7.com/mcp",
          headers: { CONTEXT7_API_KEY: placeholder },
        },
      },
    };
    expect(
      substituteVariables(config, { CONTEXT7_API_KEY: "secret" }).mcpServers.context7?.headers,
    ).toEqual({ CONTEXT7_API_KEY: "secret" });
    expect(() => substituteVariables(config, {})).toThrow(/CONTEXT7_API_KEY/);
  });

  it("blocks command servers off the allowlist", () => {
    const config = {
      mcpServers: { local: { command: "npx", args: ["-y", "foo"] } },
    };
    expect(() => assertCommandAllowlist(config, [])).toThrow(/MCP_COMMAND_ALLOWLIST/);
    expect(() => assertCommandAllowlist(config, ["npx"])).not.toThrow();
  });
});

describe("loadPluginPackage", () => {
  it("loads a minimal skills-only package", () => {
    const root = writePackage({
      name: "skills-only",
      version: "1.0.0",
      skills: true,
      mcp: false,
    });
    const loaded = loadPluginPackage(root);
    expect(loaded.manifest.name).toBe("skills-only");
    expect(loaded.components.skills).toBe(true);
    expect(loaded.components.mcp).toBe(false);
    const catalog = toCatalogVersion(loaded, "approved", root);
    expect(catalog.skillTexts[0]).toContain("sample skill");
  });
});

function baseVersion(name: string): CatalogPluginVersion {
  return {
    name,
    version: "1.0.0",
    reviewStatus: "approved",
    artifactPath: `/tmp/${name}`,
    packageRoot: `/tmp/${name}`,
    components: { skills: true, mcp: false },
    skillTexts: [`skill for ${name}`],
    mcpConfig: null,
    requiredVariables: [],
    allVariables: [],
    oauth: null,
  };
}

function effective(name: string) {
  return {
    name,
    version: "1.0.0",
    packageRoot: `/tmp/${name}`,
    components: { skills: false, mcp: true },
    skillTexts: [] as string[],
    mcpConfig: null,
    requiredVariables: [] as string[],
    allVariables: [] as string[],
    oauth: null,
  };
}

function writePackage(options: {
  name: string;
  version: string;
  skills: boolean;
  mcp: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-pkg-"));
  mkdirSync(join(root, ".pi-plugin"), { recursive: true });
  const manifest: Record<string, unknown> = {
    name: options.name,
    version: options.version,
    description: "test",
  };
  if (options.skills) {
    manifest.skills = "skills/";
    mkdirSync(join(root, "skills", "sample"), { recursive: true });
    writeFileSync(
      join(root, "skills", "sample", "SKILL.md"),
      "---\nname: sample\ndescription: test\n---\n\nsample skill body\n",
    );
  }
  if (options.mcp) {
    manifest.mcpServers = "mcp.json";
    writeFileSync(
      join(root, "mcp.json"),
      JSON.stringify({
        mcpServers: { demo: { url: "https://example.com/mcp", lifecycle: "lazy" } },
      }),
    );
  }
  writeFileSync(join(root, ".pi-plugin", "plugin.json"), JSON.stringify(manifest, null, 2));
  return root;
}
