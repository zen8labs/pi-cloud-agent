import type { Attributes } from "@opentelemetry/api";

export function outputAttributes(value: unknown): Attributes {
  const output = jsonValue(value);
  return {
    "langfuse.observation.output": output,
    "gen_ai.output.messages": jsonValue([{ role: "assistant", content: value }]),
    "gen_ai.completion": output,
  };
}

function jsonValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
