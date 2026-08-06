import { createHash } from "node:crypto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Config } from "./config";
import type { Database } from "./db/client";
import {
  claimExport,
  enqueueExport,
  ensurePendingExports,
  markExported,
  retryExport,
} from "./db/observability";
import { getRun, listEvents } from "./db/runs";
import type { Logger } from "./logger";
import { projectRun } from "./observability-projection";

const EXPORT_BATCH_SIZE = 25;
const EXPORT_INTERVAL_MS = 5_000;
const EXPORT_ATTEMPTS = 3;

export interface Observability {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(runId: string): void;
}

interface ExportBatchItem {
  row: NonNullable<Awaited<ReturnType<typeof claimExport>>>;
  spans: ReadableSpan[];
}

export function createObservability(options: {
  config: Config;
  database: Database;
  log: Logger;
}): Observability {
  const { config, database, log } = options;
  const destination = destinationId(config);
  const enabled = Boolean(config.observability.tracesEndpoint);
  const exporter = enabled
    ? new OTLPTraceExporter({
        url: config.observability.tracesEndpoint,
        headers: config.observability.tracesHeaders,
        timeoutMillis: 10_000,
      })
    : null;
  let timer: NodeJS.Timeout | null = null;
  let activeDrain: Promise<void> | null = null;
  let stopped = false;

  async function drain(): Promise<void> {
    if (!enabled || !exporter || stopped || activeDrain) return;
    activeDrain = drainPending(exporter).finally(() => {
      activeDrain = null;
    });
    await activeDrain;
  }

  async function drainPending(otelExporter: OTLPTraceExporter): Promise<void> {
    let batch: ExportBatchItem[] = [];
    try {
      await ensurePendingExports(database, destination, EXPORT_BATCH_SIZE * 2);
      batch = await claimBatch();
      if (batch.length === 0) return;
      await exportWithRetry(
        otelExporter,
        batch.flatMap((item) => item.spans),
      );
      await Promise.all(batch.map((item) => markExported(database, item.row)));
    } catch (error) {
      await Promise.all(
        batch.map((item) => retryExport(database, item.row, errorMessage(error))),
      );
      log.warn("OTLP trace export failed", { error: errorMessage(error) });
    }
  }

  async function claimBatch(): Promise<ExportBatchItem[]> {
    const batch: ExportBatchItem[] = [];
    for (let index = 0; index < EXPORT_BATCH_SIZE; index += 1) {
      const row = await claimExport(database, destination);
      if (!row) break;
      try {
        const run = await getRun(database, row.runId);
        if (!run) throw new Error("run no longer exists");
        const events = await listEvents(database, run.id, 0);
        batch.push({ row, spans: projectRun(run, events, config) });
      } catch (error) {
        await retryExport(database, row, errorMessage(error));
      }
    }
    return batch;
  }

  return {
    async start(): Promise<void> {
      if (!enabled || timer) return;
      stopped = false;
      timer = setInterval(() => void drain(), EXPORT_INTERVAL_MS);
      timer.unref();
      await drain();
      log.info("OTLP trace export enabled", {
        endpoint: config.observability.tracesEndpoint,
        exportDebugEvents: config.observability.exportDebugEvents,
      });
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (activeDrain) await activeDrain;
      if (exporter) await exporter.shutdown();
    },

    enqueue(runId: string): void {
      if (!enabled) return;
      void enqueueExport(database, runId, destination)
        .then(() => drain())
        .catch((error) =>
          log.warn("could not enqueue OTLP trace", { error: errorMessage(error) }),
        );
    },
  };
}

function destinationId(config: Config): string {
  return createHash("sha256")
    .update(`${config.observability.serviceName}\0${config.observability.tracesEndpoint}`)
    .digest("hex")
    .slice(0, 32);
}

async function exportWithRetry(
  exporter: OTLPTraceExporter,
  spans: ReadableSpan[],
): Promise<void> {
  let lastError: unknown = new Error("OTLP exporter returned no result");
  for (let attempt = 1; attempt <= EXPORT_ATTEMPTS; attempt += 1) {
    try {
      await exportSpans(exporter, spans);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < EXPORT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

function exportSpans(exporter: OTLPTraceExporter, spans: ReadableSpan[]): Promise<void> {
  return new Promise((resolve, reject) => {
    exporter.export(spans, (result) => {
      if (result.code === 0) resolve();
      else reject(result.error ?? new Error("OTLP exporter rejected the trace batch"));
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
