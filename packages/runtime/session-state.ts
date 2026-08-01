import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SANDBOX_PATHS } from "@pi-cloud-agent/protocol";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";

const CHECKPOINT_FILE = join(SANDBOX_PATHS.state, "session.jsonl");
const TIMEOUT_MS = 20_000;

export async function loadSessionManager(
  config: RuntimeConfig,
  reporter: Reporter,
): Promise<SessionManager> {
  if (!config.sessionId) return SessionManager.inMemory(config.repo.path);
  await mkdir(SANDBOX_PATHS.state, { recursive: true });

  const response = await fetch(
    `${config.controlPlaneUrl}/internal/runs/${config.runId}/checkpoint`,
    {
      headers: { Authorization: `Bearer ${config.callbackToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`could not restore Pi checkpoint: HTTP ${response.status}`);
  const body = (await response.json()) as { content: string | null };
  if (body.content) {
    await writeFile(CHECKPOINT_FILE, body.content, { encoding: "utf8", mode: 0o600 });
    reporter.log("agent.session_restored", { sessionId: config.sessionId });
    return SessionManager.open(CHECKPOINT_FILE);
  }

  reporter.log("agent.session_created", { sessionId: config.sessionId });
  return SessionManager.create(config.repo.path, SANDBOX_PATHS.state);
}

export async function saveSessionCheckpoint(
  config: RuntimeConfig,
  sessionFile: string | undefined,
  reporter: Reporter,
): Promise<void> {
  if (!config.sessionId) return;
  if (!sessionFile) throw new Error("Pi did not create a persistent session file");
  const content = await readFile(sessionFile, "utf8");
  const response = await fetch(
    `${config.controlPlaneUrl}/internal/runs/${config.runId}/checkpoint`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.callbackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`could not persist Pi checkpoint: HTTP ${response.status}`);
  reporter.log("agent.session_checkpointed", {
    sessionId: config.sessionId,
    bytes: Buffer.byteLength(content),
  });
}
