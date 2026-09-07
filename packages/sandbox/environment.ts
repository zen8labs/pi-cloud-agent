import type { SandboxSpec } from "@pi-cloud-agent/protocol";

/** Open credentials only when they cross the provider boundary into a sandbox. */
export function flattenSecrets(spec: SandboxSpec): Record<string, string> {
  const envs: Record<string, string> = {
    HOME: "/home/pi-agent",
    TMPDIR: "/workspace/.tmp",
    ...spec.env,
  };
  for (const [key, secret] of Object.entries(spec.secrets)) {
    envs[key] = secret.expose();
  }
  return envs;
}
