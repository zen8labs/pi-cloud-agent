"use client";

import { ExternalLinkIcon, LogOutIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GithubMarkIcon } from "@/components/ProviderIcons";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export const GITHUB_INSTALLATION_CHANGED = "github-installation-changed";

type State =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "required"; installUrl: string | null; problem: string | null };

/** Blocks repository work until GitHub reports at least one App-authorized repository. */
export function GithubOnboarding() {
  const [state, setState] = useState<State>({ kind: "checking" });
  const titleRef = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const result = await api.listReviewRepositories();
      setState(
        result.repositories.some((repository) => repository.problem === null)
          ? { kind: "ready" }
          : { kind: "required", installUrl: result.installUrl, problem: result.problem },
      );
    } catch (cause) {
      setState({
        kind: "required",
        installUrl: null,
        problem: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(GITHUB_INSTALLATION_CHANGED, refresh);
    return () => window.removeEventListener(GITHUB_INSTALLATION_CHANGED, refresh);
  }, [refresh]);

  useEffect(() => {
    if (state.kind === "ready") return;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    shell?.setAttribute("inert", "");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    titleRef.current?.focus();
    return () => {
      shell?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
    };
  }, [state.kind]);

  if (state.kind === "ready" || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 px-4 backdrop-blur-md">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-onboarding-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="border-b border-border bg-muted/35 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl border border-border bg-background">
              <GithubMarkIcon className="size-5" />
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                One required step
              </p>
              <h1
                ref={titleRef}
                id="github-onboarding-title"
                tabIndex={-1}
                className="mt-1 text-base font-medium outline-none"
              >
                Choose repositories for zen8agent
              </h1>
            </div>
          </div>
        </div>

        <div className="px-6 py-6">
          <p className="text-sm leading-6 text-muted-foreground">
            You are signed in. Now install the GitHub App and choose the repositories the agent
            may clone, work in, and create pull requests for.
          </p>

          <ol className="mt-5 space-y-3 text-sm">
            <OnboardingStep
              number="1"
              text="Open GitHub and select an account or organization."
            />
            <OnboardingStep
              number="2"
              text="Grant access to all repositories or choose specific ones."
            />
            <OnboardingStep
              number="3"
              text="Return here and we will verify access before enabling tasks."
            />
          </ol>

          {state.kind === "required" && state.problem ? (
            <p
              role="alert"
              className="mt-5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
            >
              {state.problem}
            </p>
          ) : null}

          <div className="mt-6 grid gap-2">
            {state.kind === "required" && state.installUrl ? (
              <a
                href={state.installUrl}
                className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground transition-colors outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <GithubMarkIcon className="size-4" />
                Choose repositories on GitHub
                <ExternalLinkIcon className="size-3.5" />
              </a>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => void refresh()}
              disabled={state.kind === "checking"}
            >
              <RefreshCwIcon
                className={state.kind === "checking" ? "size-4 animate-spin" : "size-4"}
              />
              {state.kind === "checking"
                ? "Checking access…"
                : "I’ve chosen repositories — check again"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void api.logout().finally(() => window.location.reload())}
            >
              <LogOutIcon className="size-4" />
              Sign out
            </Button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function OnboardingStep({ number, text }: { number: string; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-5 shrink-0 place-items-center rounded-full border border-border font-mono text-[10px] text-muted-foreground">
        {number}
      </span>
      <span className="leading-5">{text}</span>
    </li>
  );
}
