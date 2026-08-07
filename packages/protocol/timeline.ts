import type { RunEvent } from "./events";

type TimelineBase = {
  seq: number;
  at: string;
  data: Record<string, unknown>;
};

export type TimelineEvent = TimelineBase &
  (
    | { kind: "token"; turnNumber: number; content: string }
    | {
        kind: "tool";
        turnNumber: number;
        callId: string;
        tool: string;
        status: string;
        args: unknown;
        output: unknown;
      }
    | {
        kind: "turn";
        turnNumber: number;
        startedAt: string;
        expectedToolCalls: number;
        output: unknown;
        thinking: string;
      }
    | { kind: "log"; name: string }
    | { kind: "status" }
    | { kind: "other" }
  );

type InterpretationState = {
  currentTurn: number;
  lastCompletedTurn: number;
  turnStarts: Map<number, string>;
  toolTurns: Map<string, number>;
};

/** Interpret the durable journal once so every adapter agrees on turn and tool semantics. */
export function interpretRunEvents(events: RunEvent[]): TimelineEvent[] {
  const state: InterpretationState = {
    currentTurn: 1,
    lastCompletedTurn: 0,
    turnStarts: new Map(),
    toolTurns: new Map(),
  };
  return events.map((event) => interpretEvent(state, event));
}

function interpretEvent(state: InterpretationState, event: RunEvent): TimelineEvent {
  const base: TimelineBase = { seq: event.seq, at: event.at, data: event.data };
  if (event.type === "token") {
    return {
      ...base,
      kind: "token",
      turnNumber: state.currentTurn,
      content: stringValue(event.data.content),
    };
  }
  if (event.type === "tool_call") return interpretTool(state, event, base);
  if (event.type === "log") return interpretLog(state, event, base);
  return { ...base, kind: event.type === "status" ? "status" : "other" };
}

function interpretTool(
  state: InterpretationState,
  event: RunEvent,
  base: TimelineBase,
): TimelineEvent {
  const callId = stringValue(event.data.callId);
  const explicitTurn = numberValue(event.data.turnNumber);
  const turnNumber =
    explicitTurn ??
    state.toolTurns.get(callId) ??
    (state.lastCompletedTurn || state.currentTurn);
  if (callId) state.toolTurns.set(callId, turnNumber);
  return {
    ...base,
    kind: "tool",
    turnNumber,
    callId,
    tool: stringValue(event.data.tool) || "tool",
    status: stringValue(event.data.status) || "running",
    args: event.data.args,
    output: event.data.output,
  };
}

function interpretLog(
  state: InterpretationState,
  event: RunEvent,
  base: TimelineBase,
): TimelineEvent {
  const name = stringValue(event.data.event);
  if (name === "agent.turn_start") {
    state.currentTurn = numberValue(event.data.turnNumber) ?? state.currentTurn;
    state.turnStarts.set(state.currentTurn, stringValue(event.data.turnStartedAt) || event.at);
    return { ...base, kind: "log", name };
  }
  if (name !== "agent.turn_end") return { ...base, kind: "log", name };

  const turnNumber = numberValue(event.data.turnNumber) ?? state.currentTurn;
  const startedAt =
    stringValue(event.data.turnStartAt) || state.turnStarts.get(turnNumber) || event.at;
  state.lastCompletedTurn = Math.max(state.lastCompletedTurn, turnNumber);
  state.currentTurn = turnNumber + 1;
  return {
    ...base,
    kind: "turn",
    turnNumber,
    startedAt,
    expectedToolCalls: countToolCalls(event.data.output),
    output: event.data.output,
    thinking: thinkingText(event.data.output),
  };
}

function countToolCalls(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((total, item) => total + countToolCalls(item), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (record.type === "toolCall") return 1;
  return Array.isArray(record.tool_calls) ? record.tool_calls.length : 0;
}

function thinkingText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const record = part as Record<string, unknown>;
      return record.type === "thinking" && typeof record.thinking === "string"
        ? [record.thinking]
        : [];
    })
    .join("");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
