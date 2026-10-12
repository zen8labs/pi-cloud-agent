import type { Attributes } from "@opentelemetry/api";
import type { Config, ObservabilityDestination } from "./config";
import type { RunRow } from "./db/schema";

export interface DestinationAttributes {
  readonly name: ObservabilityDestination;
  trace(run: RunRow): Attributes;
  input(value: string): Attributes;
  output(value: unknown): Attributes;
  step(): Attributes;
}

export function createDestinationAttributes(config: Config): DestinationAttributes {
  const langfuse = config.observability.destination === "langfuse";
  return {
    name: config.observability.destination,
    trace: (run) =>
      langfuse
        ? {
            "langfuse.trace.name": "agent.run",
            ...(run.sessionId ? { "langfuse.session.id": run.sessionId } : {}),
            ...(run.userId ? { "langfuse.user.id": run.userId } : {}),
          }
        : {},
    input: (value) => (langfuse ? { "langfuse.observation.input": value } : {}),
    output: (value) => (langfuse ? { "langfuse.observation.output": jsonValue(value) } : {}),
    step: () => (langfuse ? {} : { "gen_ai.operation.name": "invoke_agent" }),
  };
}

function jsonValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
