import { readFile } from "node:fs/promises";
import type { OAuthCredential } from "@pi-cloud-agent/protocol";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";

/** Persist a credential Pi rotated in its run-local auth file before that file is removed. */
export async function persistRefreshedOAuthCredential(
  config: RuntimeConfig,
  reporter: Reporter,
  authPath: string,
): Promise<void> {
  const previous: unknown = JSON.parse(config.model.authJson);
  const stored: unknown = JSON.parse(await readFile(authPath, "utf8"));
  if (!stored || typeof stored !== "object") throw new Error("Pi OAuth credential is invalid");
  const credential = (stored as Record<string, unknown>)[config.model.provider];
  if (JSON.stringify(credential) === JSON.stringify(previous)) return;
  const updated = await reporter.modelCredential({
    previous: asOAuthCredential(previous),
    credential: asOAuthCredential(credential),
  });
  if (!updated) reporter.log("agent.oauth_credential_superseded");
}

function asOAuthCredential(value: unknown): OAuthCredential {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { type?: unknown }).type !== "oauth" ||
    typeof (value as { access?: unknown }).access !== "string" ||
    typeof (value as { refresh?: unknown }).refresh !== "string" ||
    typeof (value as { expires?: unknown }).expires !== "number"
  ) {
    throw new Error("Pi OAuth credential is invalid");
  }
  return value as OAuthCredential;
}
