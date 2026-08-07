"use client";

import type { LlmConnectionSummary, ThinkingLevel } from "@pi-cloud-agent/protocol";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChatComposer } from "@/components/ChatComposer";
import { ModelSelect } from "@/components/ModelSelect";
import { ThinkingLevelSelect } from "@/components/ThinkingLevelSelect";
import { api } from "@/lib/api";
import {
  defaultModelSelection,
  parseModelSelection,
  preferredModelSelection,
  preferredThinkingLevel,
  selectedModel,
} from "@/lib/model-selection";

export function SessionFollowUp({
  sessionId,
  repo,
  previousModel,
  previousModelConnectionId,
  previousThinkingLevel,
  active,
  onQueued,
}: {
  sessionId: string;
  repo: string;
  previousModel: string;
  previousModelConnectionId: string | null;
  previousThinkingLevel: ThinkingLevel;
  active: boolean;
  onQueued: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [modelConnections, setModelConnections] = useState<LlmConnectionSummary[]>([]);
  const [modelSelection, setModelSelection] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (active) return;
    let alive = true;
    setModelsLoading(true);
    api
      .listLlmConnections()
      .then((connections) => {
        if (!alive) return;
        setModelConnections(connections);
        const selection = preferredModelSelection(
          connections,
          previousModelConnectionId,
          previousModel,
        );
        setModelSelection(selection);
        setThinkingLevel(
          preferredThinkingLevel(selectedModel(connections, selection), previousThinkingLevel),
        );
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setModelsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [active, previousModel, previousModelConnectionId, previousThinkingLevel]);

  const selected = parseModelSelection(modelSelection);
  const canSubmit = !active && !submitting && Boolean(prompt.trim()) && Boolean(selected);

  const submit = async () => {
    if (!canSubmit || !selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createSessionTurn(sessionId, {
        prompt: prompt.trim(),
        modelConnectionId: selected.connectionId,
        modelId: selected.modelId,
        thinkingLevel,
      });
      setPrompt("");
      await onQueued();
      setSubmitting(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      const connections = await api.listLlmConnections().catch(() => null);
      if (connections) {
        setModelConnections(connections);
        setModelSelection(defaultModelSelection(connections));
        const selection = defaultModelSelection(connections);
        setThinkingLevel(preferredThinkingLevel(selectedModel(connections, selection)));
      }
      setSubmitting(false);
    }
  };

  return (
    <div>
      <ChatComposer
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        placeholder={active ? "Pi is still working…" : `Follow up on ${repo}…`}
        submitLabel="Send"
        submitEnabled={canSubmit}
        submitting={submitting}
        disabled={active || modelsLoading || modelConnections.length === 0}
        compact
        tools={
          <div className="flex min-w-0 items-center text-muted-foreground">
            <ModelSelect
              connections={modelConnections}
              value={modelSelection}
              onChange={(value) => {
                setModelSelection(value);
                setThinkingLevel(
                  preferredThinkingLevel(selectedModel(modelConnections, value), thinkingLevel),
                );
              }}
              disabled={active || modelsLoading}
              ariaLabel="Model for next turn"
              placeholder={modelsLoading ? "Loading models…" : "Choose model"}
              className="h-7 min-w-0 max-w-44 border-0 bg-transparent px-1.5 text-xs shadow-none dark:bg-transparent"
            />
            <ThinkingLevelSelect
              levels={
                selectedModel(modelConnections, modelSelection)?.thinkingLevels ?? ["off"]
              }
              value={thinkingLevel}
              onChange={setThinkingLevel}
              disabled={active || modelsLoading}
              className="h-7 min-w-0 max-w-36 border-0 bg-transparent px-1.5 text-xs shadow-none dark:bg-transparent"
            />
          </div>
        }
      />
      {modelConnections.length === 0 && !modelsLoading ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Add a model connection in{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Settings
          </Link>{" "}
          before continuing.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
