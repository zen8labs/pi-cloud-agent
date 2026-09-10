"use client";

import type { CreateLlmConnectionRequest } from "@pi-cloud-agent/protocol";
import { InfoIcon } from "lucide-react";
import { useId, useState } from "react";

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
