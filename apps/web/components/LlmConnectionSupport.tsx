"use client";

import type { CreateLlmConnectionRequest } from "@pi-cloud-agent/protocol";
import { InfoIcon } from "lucide-react";
import { useId, useState } from "react";
import { api, type LlmOAuthEvent } from "@/lib/api";

export function InfoTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className="rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <InfoIcon className="size-3.5" />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-auto absolute left-1/2 top-full z-50 mt-2 w-64 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-left text-xs leading-4 text-popover-foreground shadow-lg ${open ? "block" : "hidden group-hover:block"}`}
      >
        {children}
      </span>
    </span>
  );
}

export async function handleOAuthEvent(
  flowId: string,
  event: LlmOAuthEvent,
  authWindow: Window | null,
  onChanged: () => Promise<void>,
  setError: (value: string) => void,
  onNotice: (message: string, kind: "success" | "error") => void,
): Promise<void> {
  if (event.type === "auth") {
    const url = event.event.type === "auth_url" ? event.event.url : event.event.verificationUri;
    if (url && authWindow) authWindow.location.href = url;
    else if (url) window.location.assign(url);
    return;
  }
  if (event.type === "prompt") {
    const choices = event.prompt.options
      ?.map((option) => `${option.id}: ${option.label}`)
      .join("\n");
    const value = window.prompt(
      [event.prompt.message, choices].filter(Boolean).join("\n"),
      event.prompt.placeholder ?? event.prompt.options?.[0]?.id ?? "",
    );
    if (value !== null) await api.submitLlmOAuthInput(flowId, value);
    return;
  }
  if (event.type === "complete") {
    authWindow?.close();
    await onChanged();
    onNotice("Subscription connected.", "success");
    return;
  }
  authWindow?.close();
  setError(event.message);
  onNotice(event.message, "error");
}

export function validateConnectionForm(form: CreateLlmConnectionRequest): string | null {
  if (!form.displayName.trim()) return "Name is required";
  if (!form.baseUrl.trim()) return "Base URL is required";
  try {
    const url = new URL(form.baseUrl);
    if (url.username || url.password) return "Base URL must not contain credentials";
  } catch {
    return "Base URL must be a valid URL";
  }
  if (!form.model.trim()) return "Model is required";
  if (!form.apiKey.trim()) return "API key is required";
  if (form.thinkingLevels?.length === 0) return "Choose at least one thinking level";
  if (
    form.contextWindow !== undefined &&
    (!Number.isInteger(form.contextWindow) || form.contextWindow < 1)
  ) {
    return "Context window must be a positive integer";
  }
  if (
    form.maxTokens !== undefined &&
    (!Number.isInteger(form.maxTokens) || form.maxTokens < 1)
  ) {
    return "Max output tokens must be a positive integer";
  }
  return null;
}
