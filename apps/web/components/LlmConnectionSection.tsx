"use client";

import type {
  CreateLlmConnectionRequest,
  LlmConnectionSummary,
} from "@pi-cloud-agent/protocol";
import { PlusIcon, TestTube2Icon } from "lucide-react";
import { useState } from "react";
import {
  handleOAuthEvent,
  InfoTooltip,
  validateConnectionForm,
} from "@/components/LlmConnectionSupport";
import { LlmConnectionTable } from "@/components/LlmConnectionTable";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const ENDPOINT_OPTIONS = [
  {
    id: "openai-completions",
    label: "OpenAI-compatible · Chat Completions",
    provider: "openai-compatible",
    api: "openai-completions",
  },
  {
    id: "openai-responses",
    label: "OpenAI-compatible · Responses",
    provider: "openai-compatible",
    api: "openai-responses",
  },
  {
    id: "litellm",
    label: "LiteLLM proxy",
    provider: "litellm",
    api: "openai-completions",
  },
  {
    id: "anthropic",
    label: "Anthropic · Messages",
    provider: "anthropic",
    api: "anthropic-messages",
  },
] as const;

type EndpointId = (typeof ENDPOINT_OPTIONS)[number]["id"];

export function LlmConnectionSection({
  connections,
  onChanged,
  onNotice,
}: {
  connections: LlmConnectionSummary[];
  onChanged: () => Promise<void>;
  onNotice: (message: string, kind: "success" | "error") => void;
}) {
  const [open, setOpen] = useState(false);
  const [endpointId, setEndpointId] = useState<EndpointId>("openai-completions");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<CreateLlmConnectionRequest>({
    displayName: "",
    provider: "openai-compatible",
    api: "openai-completions",
    baseUrl: "",
    model: "",
    apiKey: "",
    contextWindow: 196_608,
    maxTokens: 32_000,
    // The server decides whether the first saved connection becomes default.
    // Do not derive this from the initial props: Settings loads connections
    // asynchronously, so that value would become stale for the lifetime of the
    // component and could replace an existing default on the next page load.
    isDefault: false,
  });

  const update = <K extends keyof CreateLlmConnectionRequest>(
    key: K,
    value: CreateLlmConnectionRequest[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const formError = validateConnectionForm(form);
  const formReady = formError === null;
  const reportError = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    onNotice(message, "error");
  };

  const selectEndpoint = (value: EndpointId) => {
    const endpoint = ENDPOINT_OPTIONS.find((option) => option.id === value);
    if (!endpoint) return;
    setEndpointId(value);
    setForm((current) => ({ ...current, provider: endpoint.provider, api: endpoint.api }));
  };

  const save = async () => {
    if (!formReady) return;
    setBusy("save");
    setError(null);
    try {
      await api.createLlmConnection(form);
      await onChanged();
      setOpen(false);
      setForm((current) => ({ ...current, apiKey: "", isDefault: false }));
      onNotice("Model connection saved.", "success");
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!formReady) return;
    setBusy("test");
    setError(null);
    try {
      await api.testLlmConnection(form);
      onNotice("Connection test succeeded.", "success");
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.deleteLlmConnection(id);
      await onChanged();
      onNotice("Model connection deleted.", "success");
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const makeDefault = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.setDefaultLlmConnection(id);
      await onChanged();
      onNotice("Default model updated.", "success");
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  const connectSubscription = async (provider: "chatgpt" | "claude") => {
    setBusy(`oauth:${provider}`);
    setError(null);
    const authWindow = window.open("about:blank", "pi-cloud-agent-oauth");
    try {
      const flow = await api.startLlmOAuth(provider);
      const pendingEvents: Promise<void>[] = [];
      await api.streamLlmOAuth(flow.eventsUrl, (event) => {
        pendingEvents.push(
          handleOAuthEvent(flow.flowId, event, authWindow, onChanged, setError, onNotice),
        );
      });
      await Promise.all(pendingEvents);
    } catch (cause) {
      authWindow?.close();
      reportError(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {connections.length > 0 && (
        <LlmConnectionTable
          connections={connections}
          busyId={busy}
          onMakeDefault={(id) => void makeDefault(id)}
          onRemove={remove}
        />
      )}
      <section className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium">Add a model</h3>
        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          Authenticate to use your ChatGPT/Claude subscriptions or define a custom model
          endpoint
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => void connectSubscription("chatgpt")}
            disabled={busy !== null}
            variant="outline"
            size="sm"
          >
            {busy === "oauth:chatgpt" ? "Connecting…" : "Connect ChatGPT plan"}
          </Button>
          <Button
            type="button"
            onClick={() => void connectSubscription("claude")}
            disabled={busy !== null}
            variant="outline"
            size="sm"
          >
            {busy === "oauth:claude" ? "Connecting…" : "Connect Claude plan"}
          </Button>
        </div>
        <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
        {open ? (
          <div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs">
                <span>
                  Name <RequiredMark />
                </span>
                <input
                  className="h-9 rounded-md border bg-background px-3"
                  value={form.displayName}
                  onChange={(e) => update("displayName", e.target.value)}
                  placeholder="My model gateway"
                  required
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span className="flex items-center gap-1">
                  Endpoint <RequiredMark />
                </span>
                <select
                  className="h-9 rounded-md border bg-background px-3"
                  value={endpointId}
                  onChange={(e) => selectEndpoint(e.target.value as EndpointId)}
                  required
                >
                  {ENDPOINT_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-xs sm:col-span-2">
                <span>
                  Base URL <RequiredMark />
                </span>
                <input
                  className="h-9 rounded-md border bg-background px-3"
                  value={form.baseUrl}
                  onChange={(e) => update("baseUrl", e.target.value)}
                  placeholder="https://api.example.com/v1"
                  type="url"
                  required
                />
              </label>
              <label className="grid gap-1.5 text-xs">
                <span>
                  Model <RequiredMark />
                </span>
                <input
                  className="h-9 rounded-md border bg-background px-3"
                  value={form.model}
                  onChange={(e) => update("model", e.target.value)}
                  placeholder="model-name"
                  required
                />
              </label>
              <label className="grid gap-1.5 text-xs sm:col-span-2">
                <span>
                  API key <RequiredMark />
                </span>
                <input
                  className="h-9 rounded-md border bg-background px-3"
                  value={form.apiKey}
                  onChange={(e) => update("apiKey", e.target.value)}
                  placeholder="Your provider key"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </label>
            </div>
            <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
              All credentials are encrypted
              <InfoTooltip label="Credential handling details">
                Credentials are stored encrypted and passed only to the isolated task process.
              </InfoTooltip>
            </p>
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" onClick={() => setOpen(false)} variant="outline" size="sm">
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void test()}
                disabled={busy !== null || !formReady}
                variant="outline"
                size="sm"
              >
                <TestTube2Icon className="size-3.5" />
                {busy === "test" ? "Testing…" : "Test"}
              </Button>
              <InfoTooltip label="What the test does">
                Sends a one-token request using this endpoint, API format, model, and key. Your
                provider may count it as usage.
              </InfoTooltip>
              <Button
                type="button"
                onClick={() => void save()}
                disabled={busy !== null || !formReady}
                size="sm"
              >
                {busy === "save" ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            onClick={() => setOpen(true)}
            variant="outline"
            size="sm"
            className="border-dashed text-muted-foreground"
          >
            <PlusIcon className="size-3.5" /> Add custom model
          </Button>
        )}
      </section>
    </div>
  );
}

function RequiredMark() {
  return <span className="text-destructive">*</span>;
}
