"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import type { AppConfig } from "@/lib/types";
import { ChatComposer } from "@/components/ChatComposer";

export default function ChatPage() {
  return (
    <Suspense>
      <ChatInner />
    </Suspense>
  );
}

function ChatInner() {
  const router = useRouter();
  const params = useSearchParams();

  const [repos, setRepos] = useState<string[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [repo, setRepo] = useState(params.get("repo") || "");
  const [customRepo, setCustomRepo] = useState("");
  const [bundle, setBundle] = useState(params.get("bundle") || "general_agent");
  const [prNumber, setPrNumber] = useState("");
  const [prompt, setPrompt] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.listRepos().then(setRepos).catch(() => setRepos([]));
    api.getConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  // Default the repo to the first configured one once loaded.
  useEffect(() => {
    if (!repo && repos.length) setRepo(repos[0]);
  }, [repos, repo]);

  const effectiveRepo = repo === "__custom__" ? customRepo.trim() : repo;

  // Pull the repo's branches so the user can pick one; default to the repo's
  // real default branch (so we never assume `main` on a `master`-only repo).
  useEffect(() => {
    if (!effectiveRepo || !effectiveRepo.includes("/")) {
      setBranches([]);
      setBranch("");
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    api
      .listBranches(effectiveRepo)
      .then(({ branches, default: def }) => {
        if (cancelled) return;
        setBranches(branches);
        setBranch(def || branches[0] || "");
      })
      .catch(() => {
        if (cancelled) return;
        setBranches([]);
        setBranch("");
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveRepo]);

  const isReview = bundle === "pr_review";
  const canSubmit =
    !!effectiveRepo &&
    (isReview ? !!prNumber.trim() : prompt.trim().length > 0) &&
    !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await api.createRun({
        repo: effectiveRepo,
        bundle,
        prompt: isReview ? prompt.trim() || "Review this pull request." : prompt.trim(),
        branch: branch || null,
        pr_number: isReview ? Number(prNumber) : null,
      });
      router.push(`/sessions/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="conversation-shell flex h-screen flex-col justify-center pb-8">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Start a session</h1>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          Pick a repo and tell the agent what to do. It runs in a fresh sandbox.
        </p>
      </div>

      {/* Repo + bundle selectors */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
        >
          {repos.length === 0 && <option value="">No repos configured</option>}
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
          <option value="__custom__">Custom repo…</option>
        </select>

        {repo === "__custom__" && (
          <input
            value={customRepo}
            onChange={(e) => setCustomRepo(e.target.value)}
            placeholder="owner/name"
            className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-sm focus:border-[var(--color-accent)] focus:outline-none"
          />
        )}

        <select
          value={bundle}
          onChange={(e) => setBundle(e.target.value)}
          className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
        >
          <option value="general_agent">Agent task</option>
          <option value="pr_review">PR review</option>
        </select>

        {/* Branch selector — PR review derives its branch from the PR itself. */}
        {!isReview && (
          <select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={branchesLoading || branches.length === 0}
            title="Branch to clone"
            className="max-w-[14rem] rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60"
          >
            {branchesLoading && <option value="">Loading branches…</option>}
            {!branchesLoading && branches.length === 0 && (
              <option value="">{branch || "default branch"}</option>
            )}
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}

        {isReview && (
          <input
            value={prNumber}
            onChange={(e) => setPrNumber(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="PR #"
            className="w-20 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
          />
        )}
      </div>

      <ChatComposer
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        placeholder={
          isReview
            ? "Optional note for the reviewer (defaults to a full review)…"
            : "Describe the task — e.g. “What is this repo about?”"
        }
        model={config?.model}
        submitLabel="Start"
        submitting={submitting}
        disabled={!effectiveRepo}
        autoFocus
      />

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
