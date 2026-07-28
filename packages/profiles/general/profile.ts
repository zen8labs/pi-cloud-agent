import { defineProfile } from "@pi-cloud-agent/protocol";
import { z } from "zod";

/**
 * A free-form task against a repository checkout.
 *
 * This is the profile with nothing in it, and that is the point: it demonstrates
 * that the core needs no profile-specific behavior to be useful. A prompt, a
 * checkout, and Pi's own tools.
 */
export const generalProfile = defineProfile({
  name: "general",
  description: "Run a free-form request against a repository checkout",

  // Nothing to configure. A profile that needs no settings should say so rather
  // than inventing some.
  configSchema: z.object({}),

  accepts(trigger) {
    // A repository event carries no request, and inventing one would make this
    // profile guess at intent. Only an explicit ask starts a run.
    return trigger.kind === "manual" && typeof trigger.prompt === "string";
  },

  buildTask(trigger) {
    const prompt = trigger.prompt?.trim();
    if (!prompt) throw new Error("the general profile requires a prompt");
    return { profile: "general", prompt, repo: trigger.repo };
  },
});
