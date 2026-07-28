import type { SandboxProvider } from "@pi-cloud-agent/protocol";
import { createE2BProvider } from "./e2b";

/**
 * @pi-cloud-agent/sandbox — where a run's compute comes from.
 *
 * Adding a backend is one file and one line in `FACTORIES`. Nothing else in the
 * system learns about it: the controller selects by name from configuration, and
 * each factory validates its own environment variables, so a new provider needs
 * no change to the controller's config schema.
 *
 * See docs/adding-a-sandbox-provider.md.
 */

type Env = Readonly<Record<string, string | undefined>>;
type Factory = (env: Env) => SandboxProvider;

const FACTORIES: Record<string, Factory> = {
  e2b: createE2BProvider,
};

export function createSandboxProvider(name: string, env: Env): SandboxProvider {
  const factory = FACTORIES[name];
  if (!factory) {
    const known = Object.keys(FACTORIES).sort().join(", ");
    throw new Error(`Unknown sandbox provider "${name}". Available: ${known}.`);
  }
  return factory(env);
}

export function sandboxProviderNames(): string[] {
  return Object.keys(FACTORIES).sort();
}

export { createE2BProvider };
