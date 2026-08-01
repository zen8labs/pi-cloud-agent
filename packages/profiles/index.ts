import type { Profile } from "@pi-cloud-agent/protocol";
import { generalProfile } from "./general/profile";
import { prReviewProfile } from "./pr-review/profile";

/**
 * @pi-cloud-agent/profiles — the verticals.
 *
 * This registry is the reason the controller has no idea what a code review is.
 * A profile owns three decisions: whether a trigger should start a run, what the
 * agent is asked to do, and what per-repository settings exist. Everything else
 * is infrastructure and belongs to the core.
 *
 * Adding one is a directory and a line here. See docs/adding-a-profile.md.
 */

// pr-review is deliberately NOT registered: its feature set (webhook intake,
// per-repo settings) was removed to be rebuilt later. The profile itself is
// kept below as the seed for that rebuild, so it stays exported and type-checked
// but never accepts a trigger at runtime.
const REGISTRY: Record<string, Profile> = {
  [generalProfile.name]: generalProfile,
};

export const DEFAULT_PROFILE = generalProfile.name;

export function getProfile(name: string): Profile {
  const profile = REGISTRY[name];
  if (!profile) {
    const known = Object.keys(REGISTRY).sort().join(", ");
    throw new Error(`Unknown profile "${name}". Available: ${known}.`);
  }
  return profile;
}

export function listProfiles(): Profile[] {
  return Object.values(REGISTRY).sort((a, b) => a.name.localeCompare(b.name));
}

export { generalProfile, prReviewProfile };
