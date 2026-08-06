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
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  type IdGenerator,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { RunEvent } from "@pi-cloud-agent/protocol";
import type { Config } from "./config";
import type { RunRow } from "./db/schema";
import { outputAttributes } from "./observability-content";

const MAX_CONTENT = 32_000;
type Tracer = ReturnType<BasicTracerProvider["getTracer"]>;

interface StepProjection {
  span: Span;
  context: Context;
  openTools: number;
  awaitingTools: boolean;
}

interface ToolProjection {
  span: Span;
  step: StepProjection;
}

interface ProjectionState {
  steps: Map<number, StepProjection>;
  tools: Map<string, ToolProjection>;
  lastTurnNumber: number;
  lastTurnOutput?: unknown;
}

export function projectRun(run: RunRow, events: RunEvent[], config: Config): ReadableSpan[] {
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
  const shared = traceAttributes(run);
  const root = tracer.startSpan("agent.run", {
    startTime: run.createdAt,
    attributes: { ...shared, ...runAttributes(run) },
  });
  const rootContext = trace.setSpan(context.active(), root);
  const state: ProjectionState = {
    steps: new Map(),
    tools: new Map(),
    lastTurnNumber: 0,
  };
  const output = new BoundedText();
  let tokenCount = 0;

  for (const event of events) {
    tokenCount = processEvent(
      event,
      new Date(event.at),
      tracer,
      rootContext,
      root,
      state,
      output,
      tokenCount,
      shared,
      config,
    );
  }

  const end = run.updatedAt;
  for (const tool of state.tools.values()) tool.span.end(end);
  for (const step of state.steps.values()) step.span.end(end);
  root.setAttribute("agent.output.delta_count", tokenCount);
  setRootOutput(root, state, output);
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
  tracer: Tracer,
  rootContext: Context,
  root: Span,
  state: ProjectionState,
  output: BoundedText,
  tokenCount: number,
  shared: Attributes,
  config: Config,
): number {
  if (event.type === "status") {
    const attributes = {
      ...shared,
      ...eventAttributes(event.data),
    };
    root.addEvent("agent.status", attributes);
    const status = tracer.startSpan("agent.status", { startTime: at, attributes }, rootContext);
    status.end(at);
    return tokenCount;
  }
  if (event.type === "token") {
    const content = stringValue(event.data.content);
    if (content) output.append(content);
    return tokenCount + 1;
  }
  if (event.type === "tool_call") {
    handleToolEvent(event, at, tracer, rootContext, state, shared);
    return tokenCount;
  }
  if (event.type === "log") {
    handleLogEvent(event, at, tracer, rootContext, root, state, shared, config);
  }
  return tokenCount;
}

function handleToolEvent(
  event: RunEvent,
  at: Date,
  tracer: Tracer,
  rootContext: Context,
  state: ProjectionState,
  shared: Attributes,
): void {
  const callId = stringValue(event.data.callId) ?? "unknown";
  const turnNumber = numberValue(event.data.turnNumber) ?? state.lastTurnNumber;
  const step = ensureStep(state, turnNumber, at, tracer, rootContext, shared);
  if (event.data.status === "running") {
    const toolName = stringValue(event.data.tool) ?? "unknown";
    const attributes: Attributes = {
      ...shared,
      "agent.tool.name": toolName,
      "agent.tool.call_id": callId,
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolName,
      "gen_ai.tool.call.id": callId,
      "gen_ai.tool.type": "extension",
    };
    if (event.data.args !== undefined) {
      const args = truncate(jsonValue(event.data.args));
      attributes["agent.tool.args"] = args;
      attributes["gen_ai.tool.call.arguments"] = args;
      attributes["langfuse.observation.input"] = args;
    }
    const span = tracer.startSpan(
      `agent.tool.${toolName}`,
      {
        startTime: at,
        attributes,
      },
      step.context,
    );
    step.openTools += 1;
    state.tools.set(callId, { span, step });
    return;
  }
  const tool = state.tools.get(callId);
  if (!tool) return;
  const result = stringValue(event.data.output);
  if (result !== null) {
    const output = truncate(result);
    tool.span.setAttribute("agent.tool.output", output);
    tool.span.setAttribute("gen_ai.tool.call.result", jsonValue(output));
    tool.span.setAttribute("gen_ai.tool.output", output);
    tool.span.setAttribute("langfuse.observation.output", jsonValue(output));
  }
  tool.span.setStatus({
    code: event.data.status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  });
  tool.span.end(at);
  tool.step.openTools = Math.max(0, tool.step.openTools - 1);
  state.tools.delete(callId);
  if (tool.step.awaitingTools && tool.step.openTools === 0) finishStep(state, turnNumber, at);
}

function handleLogEvent(
  event: RunEvent,
  at: Date,
  tracer: Tracer,
  rootContext: Context,
  root: Span,
  state: ProjectionState,
  shared: Attributes,
  config: Config,
): void {
  const name = stringValue(event.data.event) ?? "agent.log";
  if (name === "agent.turn_end") {
    handleTurnEnd(event.data, at, tracer, rootContext, state, shared);
    return;
  }
  const attributes = {
    ...shared,
    ...eventAttributes(event.data),
  };
  if (name === "agent.session_start") {
    root.addEvent(name, attributes);
    return;
  }
  if (!config.observability.exportDebugEvents) return;
  root.addEvent(name, attributes);
  const lifecycle = tracer.startSpan(
    `agent.event.${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
    { startTime: at, attributes },
    rootContext,
  );
  lifecycle.end(at);
}

function handleTurnEnd(
  data: Record<string, unknown>,
  at: Date,
  tracer: Tracer,
  rootContext: Context,
  state: ProjectionState,
  shared: Attributes,
): void {
  const turnNumber = numberValue(data.turnNumber) ?? state.lastTurnNumber + 1;
  const start = dateValue(data.turnStartAt) ?? at;
  closeEarlierSteps(state, turnNumber, start);
  const step = ensureStep(state, turnNumber, start, tracer, rootContext, shared);
  const attributes = {
    ...shared,
    ...generationAttributes(data),
  };
  const turn = tracer.startSpan("agent.turn", { startTime: start, attributes }, step.context);
  turn.setStatus({ code: SpanStatusCode.OK });
  turn.end(at);
  if (data.output !== undefined) state.lastTurnOutput = data.output;
  state.lastTurnNumber = Math.max(state.lastTurnNumber, turnNumber);
  step.awaitingTools = containsToolCall(data.output);
  if (!step.awaitingTools && step.openTools === 0) finishStep(state, turnNumber, at);
}

function ensureStep(
  state: ProjectionState,
  turnNumber: number,
  start: Date,
  tracer: Tracer,
  rootContext: Context,
  shared: Attributes,
): StepProjection {
  const existing = state.steps.get(turnNumber);
  if (existing) return existing;
  const span = tracer.startSpan(
    "agent.step",
    {
      startTime: start,
      attributes: { ...shared, "agent.step.turn_number": turnNumber },
    },
    rootContext,
  );
  const step = {
    span,
    context: trace.setSpan(rootContext, span),
    openTools: 0,
    awaitingTools: false,
  };
  state.steps.set(turnNumber, step);
  return step;
}

function closeEarlierSteps(state: ProjectionState, turnNumber: number, at: Date): void {
  for (const [number, step] of state.steps) {
    if (number < turnNumber && step.openTools === 0) finishStep(state, number, at);
  }
}

function finishStep(state: ProjectionState, turnNumber: number, at: Date): void {
  const step = state.steps.get(turnNumber);
  if (!step || step.openTools > 0) return;
  step.span.end(at);
  state.steps.delete(turnNumber);
}

function traceAttributes(run: RunRow): Attributes {
  const attributes: Attributes = {
    "langfuse.trace.name": "agent.run",
    "agent.run.id": run.id,
  };
  if (run.sessionId) {
    attributes["session.id"] = run.sessionId;
    attributes["langfuse.session.id"] = run.sessionId;
    attributes["gen_ai.conversation.id"] = run.sessionId;
  }
  if (run.userId) {
    attributes["user.id"] = run.userId;
    attributes["langfuse.user.id"] = run.userId;
  }
  return attributes;
}

function runAttributes(run: RunRow): Attributes {
  const attributes: Attributes = {
    "agent.profile": run.profile,
    "agent.model": run.model,
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.provider.name": run.model.split("/", 1)[0] ?? run.model,
    "gen_ai.request.model": run.model,
    "agent.vcs.provider": run.provider,
    "agent.repository": run.repoFullName,
  };
  const prompt = run.trigger.prompt ?? run.trigger.command;
  if (prompt) {
    const input = jsonValue([{ role: "user", content: prompt }]);
    attributes["gen_ai.prompt"] = truncate(prompt);
    attributes["langfuse.observation.input"] = input;
    attributes["gen_ai.input.messages"] = input;
  }
  return attributes;
}

function generationAttributes(data: Record<string, unknown>): Attributes {
  const attributes: Attributes = { "gen_ai.operation.name": "chat" };
  const stopReason = stringValue(data.stopReason);
  if (stopReason) attributes["gen_ai.response.finish_reasons"] = [stopReason];
  if (data.output !== undefined) {
    Object.assign(attributes, outputAttributes(data.output));
  }
  const usage = data.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return attributes;
  const values = usage as Record<string, unknown>;
  const input = numberValue(values.input);
  const output = numberValue(values.output);
  const reasoning = numberValue(values.reasoning);
  const total = numberValue(values.totalTokens);
  if (input !== undefined) attributes["gen_ai.usage.input_tokens"] = input;
  if (output !== undefined) attributes["gen_ai.usage.output_tokens"] = output;
  if (reasoning !== undefined) attributes["gen_ai.usage.reasoning.output_tokens"] = reasoning;
  if (total !== undefined) attributes["agent.usage.total_tokens"] = total;
  return attributes;
}

function setRootOutput(root: Span, state: ProjectionState, output: BoundedText): void {
  const latestOutput = state.lastTurnOutput
    ? state.lastTurnOutput
    : output.value() || undefined;
  if (latestOutput !== undefined) setAttributes(root, outputAttributes(latestOutput));
}

function setAttributes(span: Span, attributes: Attributes): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(key, value);
  }
}

function eventAttributes(data: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "event") continue;
    const primitive = attributeValue(value);
    if (primitive !== undefined) attributes[`agent.event.${key}`] = primitive;
    else attributes[`agent.event.${key}`] = truncate(jsonValue(value));
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

function containsToolCall(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsToolCall);
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (object.type === "toolCall") return true;
  return Array.isArray(object.tool_calls) && object.tool_calls.length > 0;
}

function dateValue(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
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
    const compact = this.traceId.replaceAll("-", "");
    return /^[0-9a-f]{32}$/i.test(compact)
      ? compact.toLowerCase()
      : createHash("sha256").update(this.traceId).digest("hex").slice(0, 32);
  }
  generateSpanId(): string {
    this.sequence += 1;
    return createHash("sha256")
      .update(`${this.traceId}:span:${this.sequence}`)
      .digest("hex")
      .slice(0, 16);
  }
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
