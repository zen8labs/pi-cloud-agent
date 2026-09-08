import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SANDBOX_PATHS } from "@pi-cloud-agent/protocol";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";

const CHECKPOINT_FILE = join(SANDBOX_PATHS.state, "session.jsonl");
const TIMEOUT_MS = 20_000;
const CHECKPOINT_ATTEMPTS = 4;

export async function loadSessionManager(
  config: RuntimeConfig,
  reporter: Reporter,
): Promise<SessionManager> {
  if (!config.sessionId) return SessionManager.inMemory(config.repo.path);
  await mkdir(SANDBOX_PATHS.state, { recursive: true });

  const response = await fetchCheckpoint(config, { method: "GET" });
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
  await fetchCheckpoint(config, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  reporter.log("agent.session_checkpointed", {
    sessionId: config.sessionId,
    bytes: Buffer.byteLength(content),
  });
}

async function fetchCheckpoint(
  config: RuntimeConfig,
  init: RequestInit & { method: "GET" | "PUT" },
): Promise<Response> {
  const url = `${config.controlPlaneUrl}/internal/runs/${config.runId}/checkpoint`;
  const headers = { Authorization: `Bearer ${config.callbackToken}`, ...init.headers };
  let lastError: unknown;
  for (let attempt = 1; attempt <= CHECKPOINT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < CHECKPOINT_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }
  const action = init.method === "GET" ? "restore" : "persist";
  throw new Error(
    `could not ${action} Pi checkpoint: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
