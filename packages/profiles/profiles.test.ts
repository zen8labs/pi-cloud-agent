import type { RepoRef, Trigger, TriggerKind } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import { getProfile, listProfiles } from "./index";

/**
 * Profiles own two decisions the controller must never make: whether a trigger
 * starts a run, and what the agent is asked to do. These tests cover both, plus
 * the config contract that lets the dashboard render settings the core does not
 * understand.
 */

const repo: RepoRef = {
  provider: "github",
  host: "github.com",
  owner: "acme",
  name: "widgets",
  cloneUrl: "https://github.com/acme/widgets.git",
  defaultBranch: "main",
  baseSha: "base",
  headSha: "head",
  headBranch: "feature",
  prNumber: 42,
};

function trigger(kind: TriggerKind, extra: Partial<Trigger> = {}): Trigger {
  return { kind, repo, ...extra };
}

describe("every profile", () => {
  it("is registered under its own name and describes itself", () => {
    for (const profile of listProfiles()) {
      expect(getProfile(profile.name)).toBe(profile);
      expect(profile.description.length).toBeGreaterThan(0);
    }
  });

  it("accepts an empty stored config, so an unconfigured repo still works", () => {
    for (const profile of listProfiles()) {
      expect(() => profile.parseConfig({})).not.toThrow();
      expect(() => profile.parseConfig(undefined)).not.toThrow();
    }
  });

  it("publishes a JSON Schema for the dashboard to render", () => {
    for (const profile of listProfiles()) {
      expect(profile.configJsonSchema.type).toBe("object");
    }
  });

  it("names itself in the tasks it builds, so a run cannot be misattributed", () => {
    for (const profile of listProfiles()) {
      const candidates: Trigger[] = [
        trigger("manual", { prompt: "do the thing" }),
        trigger("pr_opened"),
      ];
      for (const candidate of candidates) {
        if (!profile.accepts(candidate, {})) continue;
        expect(profile.buildTask(candidate, {}).profile).toBe(profile.name);
      }
    }
  });

  it("rejects an unknown name with the list of known ones", () => {
    expect(() => getProfile("nope")).toThrow(/Unknown profile "nope".*Available:/s);
  });
});

describe("general", () => {
  const general = getProfile("general");

  it("only runs when a human actually asked for something", () => {
    expect(general.accepts(trigger("manual", { prompt: "explain this repo" }), {})).toBe(true);
    // A repository event carries no request; inventing one would be guesswork.
    expect(general.accepts(trigger("manual"), {})).toBe(false);
    expect(general.accepts(trigger("pr_opened"), {})).toBe(false);
    expect(general.accepts(trigger("pr_comment", { command: "/review" }), {})).toBe(false);
  });

  it("passes the request through verbatim", () => {
    const task = general.buildTask(trigger("manual", { prompt: "  explain this repo  " }), {});
    expect(task.prompt).toBe("explain this repo");
    expect(task.repo).toEqual(repo);
  });
});

describe("pr-review", () => {
  const review = getProfile("pr-review");
  const defaults = review.parseConfig({});

  it("reviews on open and update by default", () => {
    expect(review.accepts(trigger("pr_opened"), defaults)).toBe(true);
    expect(review.accepts(trigger("pr_updated"), defaults)).toBe(true);
  });

  it("honours per-repo trigger policy — the reason config exists", () => {
    const quiet = review.parseConfig({ onUpdated: false });
    expect(review.accepts(trigger("pr_updated"), quiet)).toBe(false);
    expect(review.accepts(trigger("pr_opened"), quiet)).toBe(true);
  });

  it("only answers a comment that is actually a command", () => {
    expect(review.accepts(trigger("pr_comment", { command: "/review please" }), defaults)).toBe(
      true,
    );
    expect(review.accepts(trigger("pr_comment", { command: "  /REVIEW  " }), defaults)).toBe(
      true,
    );
    expect(
      review.accepts(trigger("pr_comment", { command: "looks good to me" }), defaults),
    ).toBe(false);
    expect(review.accepts(trigger("pr_comment"), defaults)).toBe(false);
  });

  it("supports custom command prefixes", () => {
    const config = review.parseConfig({ commands: ["/audit"] });
    expect(review.accepts(trigger("pr_comment", { command: "/audit" }), config)).toBe(true);
    expect(review.accepts(trigger("pr_comment", { command: "/review" }), config)).toBe(false);
  });

  it("refuses a trigger with no pull request to review", () => {
    const noPr = { kind: "pr_opened" as const, repo: { ...repo, prNumber: null } };
    expect(review.accepts(noPr, defaults)).toBe(false);
    expect(() => review.buildTask(noPr, defaults)).toThrow(/requires a pull request/);
  });

  it("names the pull request in the prompt", () => {
    expect(review.buildTask(trigger("pr_opened"), defaults).prompt).toContain("#42");
  });

  it("pins the clone branch when a repo configures one", () => {
    const pinned = review.parseConfig({ branch: "release" });
    expect(review.buildTask(trigger("pr_opened"), pinned).repo.defaultBranch).toBe("release");
    expect(review.buildTask(trigger("pr_opened"), defaults).repo.defaultBranch).toBe("main");
  });

  it("rejects stored config that does not match its schema", () => {
    expect(() => review.parseConfig({ onOpened: "yes please" })).toThrow();
  });

  it("carries a skill for the agent to follow", () => {
    expect(review.skill).toContain("pr-review");
  });
});
