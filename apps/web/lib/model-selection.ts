import type {
  LlmConnectionSummary,
  LlmModelOption,
  ThinkingLevel,
} from "@pi-cloud-agent/protocol";

export interface ModelSelection {
  connectionId: string;
  modelId: string;
}

export function modelSelectionValue(connectionId: string, modelId: string): string {
  return `${connectionId}::${modelId}`;
}

export function parseModelSelection(value: string): ModelSelection | null {
  const separator = value.indexOf("::");
  if (separator < 1 || separator === value.length - 2) return null;
  return { connectionId: value.slice(0, separator), modelId: value.slice(separator + 2) };
}

export function defaultModelSelection(connections: LlmConnectionSummary[]): string {
  const connection = connections.find((entry) => entry.isDefault) ?? connections[0];
  return connection ? modelSelectionValue(connection.id, connection.model) : "";
}

export function selectedModel(
  connections: LlmConnectionSummary[],
  value: string,
): LlmModelOption | null {
  const selection = parseModelSelection(value);
  if (!selection) return null;
  return (
    connections
      .find((connection) => connection.id === selection.connectionId)
      ?.models.find((model) => model.id === selection.modelId) ?? null
  );
}

export function preferredThinkingLevel(
  model: LlmModelOption | null,
  previous?: ThinkingLevel,
): ThinkingLevel {
  if (!model) return "off";
  const levels = model.thinkingLevels ?? ["off"];
  if (previous && levels.includes(previous)) return previous;
  if (levels.includes("medium")) return "medium";
  return levels[0] ?? "off";
}

export function preferredModelSelection(
  connections: LlmConnectionSummary[],
  previousConnectionId: string | null,
  previousModelSnapshot: string,
): string {
  const previousModelId = previousModelSnapshot.slice(previousModelSnapshot.indexOf("/") + 1);
  const previous = previousConnectionId
    ? connections
        .find((connection) => connection.id === previousConnectionId)
        ?.models.find((model) => model.id === previousModelId)
    : null;
  return previous && previousConnectionId
    ? modelSelectionValue(previousConnectionId, previous.id)
    : defaultModelSelection(connections);
}
