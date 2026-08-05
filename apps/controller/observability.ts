import { createHash } from "node:crypto";
import {
  type Attributes,
  type AttributeValue,
  type Context,
  context,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  type IdGenerator,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { RunEvent } from "@pi-cloud-agent/protocol";
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
import type { RunRow } from "./db/schema";
import type { Logger } from "./logger";

const EXPORT_BATCH_SIZE = 25;
const EXPORT_INTERVAL_MS = 5_000;
const EXPORT_ATTEMPTS = 3;
const MAX_CONTENT = 32_000;
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
        captureContent: config.observability.captureContent,
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

function projectRun(run: RunRow, events: RunEvent[], config: Config): ReadableSpan[] {
  const processor = new CollectingSpanProcessor();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": config.observability.serviceName,
      "service.namespace": "pi-cloud-agent",
      "service.version": "0.1.0",
    }),
    idGenerator: new DeterministicIdGenerator(run.id),
    spanProcessors: [processor],
    spanLimits: { attributeValueLengthLimit: MAX_CONTENT },
  });
  const tracer = provider.getTracer("pi-cloud-agent/controller", "0.1.0");
  const root = tracer.startSpan("agent.run", {
    startTime: run.createdAt,
    attributes: runAttributes(run, config),
  });
  const rootContext = trace.setSpan(context.active(), root);
  const openTools = new Map<string, Span>();
  const output = new BoundedText();
  let tokenCount = 0;
  let turnStart = run.createdAt;

  for (const event of events) {
    const next = processEvent(
      event,
      new Date(event.at),
      tracer,
      rootContext,
      root,
      openTools,
      output,
      tokenCount,
      turnStart,
      config.observability.captureContent,
    );
    tokenCount = next.tokenCount;
    turnStart = next.turnStart;
  }
  const end = run.updatedAt;
  for (const span of openTools.values()) span.end(end);
  root.setAttribute("agent.output.delta_count", tokenCount);
  if (config.observability.captureContent && output.value()) {
    const response = jsonValue([{ role: "assistant", content: output.value() }]);
    root.setAttribute("langfuse.observation.output", response);
    root.setAttribute("gen_ai.completion", output.value());
    root.setAttribute("gen_ai.response.output", output.value());
    root.setAttribute("gen_ai.output.messages", response);
  }
  root.setAttribute("agent.run.status", run.status);
  if (run.error) root.setAttribute("error.message", truncate(run.error));
  root.setStatus({
    code: run.status === "succeeded" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    message: run.error ?? undefined,
  });
  root.end(end);
  void provider.shutdown();
  return processor.spans;
}

function processEvent(
  event: RunEvent,
  at: Date,
  tracer: ReturnType<BasicTracerProvider["getTracer"]>,
  rootContext: Context,
  root: Span,
  openTools: Map<string, Span>,
  output: BoundedText,
  tokenCount: number,
  turnStart: Date,
  captureContent: boolean,
): { tokenCount: number; turnStart: Date } {
  if (event.type === "status") {
    root.addEvent("agent.status", eventAttributes(event.data, captureContent));
    const status = tracer.startSpan(
      "agent.status",
      {
        startTime: at,
        attributes: eventAttributes(event.data, captureContent),
      },
      rootContext,
    );
    status.end(at);
    return { tokenCount, turnStart };
  }
  if (event.type === "token") {
    const content = stringValue(event.data.content);
    if (content) output.append(content);
    return { tokenCount: tokenCount + 1, turnStart };
  }
  if (event.type === "tool_call") {
    handleToolEvent(event, at, tracer, rootContext, openTools, captureContent);
    return { tokenCount, turnStart };
  }
  if (event.type === "log") {
    handleLogEvent(event, at, tracer, rootContext, root, captureContent, turnStart);
    return {
      tokenCount,
      turnStart: event.data.event === "agent.turn_end" ? at : turnStart,
    };
  }
  return { tokenCount, turnStart };
}

function runAttributes(run: RunRow, config: Config): Attributes {
  const attributes: Attributes = {
    "agent.run.id": run.id,
    "agent.profile": run.profile,
    "agent.model": run.model,
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.provider.name": run.model.split("/", 1)[0] ?? run.model,
    "gen_ai.request.model": run.model,
    "agent.vcs.provider": run.provider,
    "agent.repository": run.repoFullName,
  };
  if (run.sessionId) {
    attributes["session.id"] = run.sessionId;
    attributes["gen_ai.conversation.id"] = run.sessionId;
  }
  if (config.observability.captureContent) {
    const prompt = run.trigger.prompt ?? run.trigger.command;
    if (prompt) {
      const input = jsonValue([{ role: "user", content: prompt }]);
      attributes["gen_ai.prompt"] = truncate(prompt);
      attributes["langfuse.observation.input"] = input;
      attributes["gen_ai.input.messages"] = input;
    }
  }
  return attributes;
}

function handleToolEvent(
  event: RunEvent,
  at: Date,
  tracer: ReturnType<BasicTracerProvider["getTracer"]>,
  parent: Context,
  openTools: Map<string, Span>,
  captureContent: boolean,
): void {
  const callId = stringValue(event.data.callId) ?? "unknown";
  if (event.data.status === "running") {
    const span = tracer.startSpan(
      `agent.tool.${stringValue(event.data.tool) ?? "unknown"}`,
      {
        startTime: at,
        attributes: {
          "agent.tool.name": stringValue(event.data.tool) ?? "unknown",
          "agent.tool.call_id": callId,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": stringValue(event.data.tool) ?? "unknown",
          ...(captureContent && event.data.args !== undefined
            ? {
                "agent.tool.args": truncate(jsonValue(event.data.args)),
                "langfuse.observation.input": truncate(jsonValue(event.data.args)),
              }
            : {}),
        },
      },
      parent,
    );
    openTools.set(callId, span);
    return;
  }
  const span = openTools.get(callId);
  if (!span) return;
  const output = stringValue(event.data.output);
  if (captureContent && output) {
    const result = truncate(output);
    span.setAttribute("agent.tool.output", result);
    span.setAttribute("langfuse.observation.output", jsonValue(result));
    span.setAttribute("gen_ai.tool.output", result);
  }
  if (event.data.status === "error") {
    span.setStatus({ code: SpanStatusCode.ERROR });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end(at);
  openTools.delete(callId);
}

function handleLogEvent(
  event: RunEvent,
  at: Date,
  tracer: ReturnType<BasicTracerProvider["getTracer"]>,
  parent: Context,
  root: Span,
  captureContent: boolean,
  turnStart: Date,
): void {
  const name = stringValue(event.data.event) ?? "agent.log";
  const attributes =
    name === "agent.turn_end"
      ? generationAttributes(event.data, captureContent)
      : eventAttributes(event.data, captureContent);
  root.addEvent(name, attributes);
  if (name !== "agent.turn_end") {
    const lifecycle = tracer.startSpan(
      `agent.event.${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
      {
        startTime: at,
        attributes,
      },
      parent,
    );
    lifecycle.end(at);
    return;
  }
  const turn = tracer.startSpan("agent.turn", { startTime: turnStart, attributes }, parent);
  turn.setStatus({ code: SpanStatusCode.OK });
  turn.end(at);
}

function generationAttributes(
  data: Record<string, unknown>,
  captureContent: boolean,
): Attributes {
  const attributes = eventAttributes(data, captureContent);
  attributes["gen_ai.operation.name"] = "chat";
  if (captureContent && data.output !== undefined) {
    const completion = jsonValue(data.output);
    attributes["langfuse.observation.output"] = completion;
    attributes["gen_ai.completion"] = completion;
  }
  const usage = data.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return attributes;
  const values = usage as Record<string, unknown>;
  const input = numberValue(values.input);
  const output = numberValue(values.output);
  const total = numberValue(values.totalTokens);
  if (input !== undefined) attributes["gen_ai.usage.input_tokens"] = input;
  if (output !== undefined) attributes["gen_ai.usage.output_tokens"] = output;
  if (total !== undefined) attributes["agent.usage.total_tokens"] = total;
  return attributes;
}
function eventAttributes(data: Record<string, unknown>, captureContent: boolean): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "event") continue;
    const primitive = attributeValue(value);
    if (primitive !== undefined) attributes[`agent.event.${key}`] = primitive;
    else if (captureContent) attributes[`agent.event.${key}`] = truncate(jsonValue(value));
  }
  return attributes;
}
function attributeValue(value: unknown): AttributeValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => attributeValue(item) !== undefined)) {
    return value as AttributeValue;
  }
  return undefined;
}
function jsonValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function truncate(value: string): string {
  return value.length <= MAX_CONTENT ? value : `${value.slice(0, MAX_CONTENT)}…`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

class CollectingSpanProcessor implements SpanProcessor {
  readonly spans: ReadableSpan[] = [];

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

class DeterministicIdGenerator implements IdGenerator {
  private sequence = 0;

  constructor(private readonly traceId: string) {}

  generateTraceId(): string {
    return normalizeTraceId(this.traceId);
  }

  generateSpanId(): string {
    this.sequence += 1;
    return createHash("sha256")
      .update(`${this.traceId}:span:${this.sequence}`)
      .digest("hex")
      .slice(0, 16);
  }
}

function normalizeTraceId(value: string): string {
  const compact = value.replaceAll("-", "");
  return /^[0-9a-f]{32}$/i.test(compact)
    ? compact.toLowerCase()
    : createHash("sha256").update(value).digest("hex").slice(0, 32);
}

class BoundedText {
  private text = "";

  append(value: string): void {
    if (this.text.length >= MAX_CONTENT) return;
    this.text += value.slice(0, MAX_CONTENT - this.text.length);
  }

  value(): string {
    return this.text;
  }
}
