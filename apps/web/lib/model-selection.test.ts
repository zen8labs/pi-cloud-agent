import type { LlmConnectionSummary } from "@pi-cloud-agent/protocol";
import { describe, expect, it } from "vitest";
import {
  defaultModelSelection,
  modelSelectionValue,
  parseModelSelection,
} from "./model-selection";

function connection(
  id: string,
  model: string,
  isDefault: boolean,
  models = [model],
): LlmConnectionSummary {
  return {
    id,
    displayName: id,
    provider: id,
    authType: "api_key",
    api: "openai-responses",
    baseUrl: "https://models.example/v1",
    model,
    models: models.map((id) => ({
      id,
      contextWindow: 16_384,
      maxTokens: 2_048,
      thinkingLevels: ["off"],
    })),
    contextWindow: 16_384,
    maxTokens: 2_048,
    isDefault,
    warning: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
}

describe("turn model selection", () => {
  it("starts each composer on the current default connection", () => {
    const connections = [
      connection("11111111-1111-4111-8111-111111111111", "old-model", false),
      connection("22222222-2222-4222-8222-222222222222", "default-model", true),
    ];

    expect(parseModelSelection(defaultModelSelection(connections))).toEqual({
      connectionId: "22222222-2222-4222-8222-222222222222",
      modelId: "default-model",
    });
  });

  it("starts on the preferred model within the default connection", () => {
    const connections = [
      connection("22222222-2222-4222-8222-222222222222", "gpt-5.6-luna", true, [
        "gpt-5.3-codex-spark",
        "gpt-5.6-luna",
      ]),
    ];

    expect(parseModelSelection(defaultModelSelection(connections))?.modelId).toBe(
      "gpt-5.6-luna",
    );
  });

  it("round-trips an explicit connection and model choice", () => {
    const value = modelSelectionValue("33333333-3333-4333-8333-333333333333", "model::name");
    expect(parseModelSelection(value)).toEqual({
      connectionId: "33333333-3333-4333-8333-333333333333",
      modelId: "model::name",
    });
  });
});
