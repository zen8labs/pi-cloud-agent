"use client";

import { KeyRoundIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GITHUB_INSTALLATION_CHANGED } from "@/components/GithubOnboarding";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export const LLM_CONNECTION_CHANGED = "llm-connection-changed";

const MODEL_ONBOARDING_HIDE_MS = 2 * 60 * 1000;

/** After GitHub is connected, nudges the user to add Codex or a model key without freezing the UI. */
export function ModelOnboarding() {
  const [needed, setNeeded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [github, models] = await Promise.all([
        api.listReviewRepositories(),
        api.listLlmConnections(),
      ]);
      const githubReady = github.repositories.some((repository) => repository.problem === null);
      setNeeded(githubReady && models.length === 0);
    } catch {
      setNeeded(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(GITHUB_INSTALLATION_CHANGED, onChange);
    window.addEventListener(LLM_CONNECTION_CHANGED, onChange);
    return () => {
      window.removeEventListener(GITHUB_INSTALLATION_CHANGED, onChange);
      window.removeEventListener(LLM_CONNECTION_CHANGED, onChange);
    };
  }, [refresh]);

  useEffect(() => {
    if (!needed || dismissed) return;
    const timer = window.setTimeout(() => setDismissed(true), MODEL_ONBOARDING_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [needed, dismissed]);

  if (dismissed || !needed || typeof document === "undefined") return null;

  return createPortal(
    <aside
      aria-labelledby="model-onboarding-title"
      className="fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
    >
      <div className="flex items-start gap-3 border-b border-border bg-muted/35 px-4 py-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground">
          <KeyRoundIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            One remaining step
          </p>
          <h2 id="model-onboarding-title" className="mt-1 text-sm font-medium">
            Connect a model
          </h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss model setup"
          onClick={() => setDismissed(true)}
        >
          <XIcon />
        </Button>
      </div>
      <div className="px-4 py-4">
        <p className="text-sm leading-6 text-muted-foreground">
          Connect Codex or add a model API key in Settings. Tasks cannot start without a model.
        </p>
        <Link
          href="/settings"
          onClick={() => setDismissed(true)}
          className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground transition-colors outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Add a model
        </Link>
      </div>
    </aside>,
    document.body,
  );
}
