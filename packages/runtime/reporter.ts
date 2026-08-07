import {
  isDebugAgentEvent,
  type OAuthCredentialUpdate,
  type RunEventInput,
  type RunStatusReport,
} from "@pi-cloud-agent/protocol";
import type { RuntimeConfig } from "./config";
import { createRuntimeRedactor } from "./config";

/**
 * Outbound-only reporting.
 *
 * Two channels with deliberately different guarantees. Most telemetry is fire
 * and forget in order: dropping a token event costs a line in the feed, so it is
 * not worth retrying or blocking the agent for. The final git snapshot is the
 * exception and gets bounded retries before the terminal status. That status is
 * the only thing that completes a run, so it retries with backoff, and if it never
 * lands the controller's reconciler eventually times the run out rather than
 * leaving it live forever.
 *
 * Everything sent passes through the redactor first. This is the right place for
 * it: the sandbox is the only side that knows every secret in play.
 */
export interface Reporter {
  event(event: RunEventInput): void;
  log(event: string, fields?: Record<string, unknown>): void;
  status(report: RunStatusReport): Promise<void>;
  modelCredential(update: OAuthCredentialUpdate): Promise<boolean>;
  /** Wait for queued telemetry to drain. Called before reporting terminal status. */
  flush(): Promise<void>;
}

const TELEMETRY_TIMEOUT_MS = 10_000;
const DIFF_EVENT_ATTEMPTS = 4;
const STATUS_ATTEMPTS = 4;

export function createReporter(config: RuntimeConfig): Reporter {
  const clean = createRuntimeRedactor();
  const headers = {
    Authorization: `Bearer ${config.callbackToken}`,
    "Content-Type": "application/json",
  };

  // Telemetry is chained rather than concurrent so the controller assigns
  // sequence numbers in the order things actually happened.
  let queue: Promise<void> = Promise.resolve();

  async function post(path: string, body: unknown, timeoutMs: number): Promise<void> {
    const response = await fetch(`${config.controlPlaneUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  async function postDiff(body: RunEventInput): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= DIFF_EVENT_ATTEMPTS; attempt += 1) {
      try {
        await post(`/internal/runs/${config.runId}/events`, body, TELEMETRY_TIMEOUT_MS);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < DIFF_EVENT_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
        }
      }
    }
    throw lastError;
  }

  const reporter: Reporter = {
    event(event: RunEventInput): void {
      const scrubbed = { ...event, data: scrubDeep(event.data, clean) } as RunEventInput;
      queue = queue.then(async () => {
        try {
          if (scrubbed.type === "log" && scrubbed.data.event === "git.diff") {
            await postDiff(scrubbed);
          } else {
            await post(`/internal/runs/${config.runId}/events`, scrubbed, TELEMETRY_TIMEOUT_MS);
          }
        } catch (error) {
          // Never escalate: telemetry loss must not fail a run that is working.
          process.stderr.write(`telemetry dropped: ${clean(String(error))}\n`);
        }
      });
    },

    log(event: string, fields: Record<string, unknown> = {}): void {
      if (!config.debugEvents && isDebugAgentEvent(event)) return;
      reporter.event({ type: "log", data: { event, ...fields } });
    },

    async status(report: RunStatusReport): Promise<void> {
      const body: RunStatusReport = {
        status: report.status,
        detail: report.detail ? clean(report.detail) : report.detail,
      };
      let lastError: unknown;
      for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt += 1) {
        try {
          await post(`/internal/runs/${config.runId}/status`, body, TELEMETRY_TIMEOUT_MS);
          return;
        } catch (error) {
          lastError = error;
          if (attempt < STATUS_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
          }
        }
      }
      throw new Error(`could not report terminal status: ${clean(String(lastError))}`);
    },

    async modelCredential(update: OAuthCredentialUpdate): Promise<boolean> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt += 1) {
        try {
          const response = await fetch(
            `${config.controlPlaneUrl}/internal/runs/${config.runId}/model-credential`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(update),
              signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
            },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const result: unknown = await response.json();
          return Boolean(
            result && typeof result === "object" && (result as { updated?: unknown }).updated,
          );
        } catch (error) {
          lastError = error;
          if (attempt < STATUS_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
          }
        }
      }
      throw new Error(`could not persist model credential: ${clean(String(lastError))}`);
    },

    async flush(): Promise<void> {
      await queue;
    },
  };

  return reporter;
}

/** Redact strings anywhere in an event payload, including nested tool arguments. */
function scrubDeep(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, clean));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = scrubDeep(nested, clean);
    return out;
  }
  return value;
}
