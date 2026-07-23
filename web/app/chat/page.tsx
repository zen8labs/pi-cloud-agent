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
  const [profile, setProfile] = useState(params.get("profile") || "general_agent");
  const [model, setModel] = useState<string>("");
  const [prNumber, setPrNumber] = useState("");
  const [prompt, setPrompt] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listRepos().then(setRepos).catch(() => setRepos([]));
    api.getConfig().then((cfg) => {
      setConfig(cfg);
      setModel((prev) => prev || cfg.default_model);
    }).catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    if (!repo && repos.length) setRepo(repos[0]);
  }, [repos, repo]);

  const effectiveRepo = repo === "__custom__" ? customRepo.trim() : repo;

  useEffect(() => {
    if (!effectiveRepo || !effectiveRepo.includes("/")) {
      setBranches([]); setBranch(""); return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    api.listBranches(effectiveRepo)
      .then(({ branches, default: def }) => {
        if (cancelled) return;
        setBranches(branches);
        setBranch(def || branches[0] || "");
      })
      .catch(() => { if (!cancelled) { setBranches([]); setBranch(""); } })
      .finally(() => { if (!cancelled) setBranchesLoading(false); });
    return () => { cancelled = true; };
  }, [effectiveRepo]);

  const isReview = profile === "pr_review";
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
        profile,
        prompt: isReview ? prompt.trim() || "Review this pull request." : prompt.trim(),
        branch: branch || null,
        pr_number: isReview ? Number(prNumber) : null,
        model: model || null,
      });
      router.push(`/sessions/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen flex-col" style={{ background: "var(--color-canvas)" }}>
      {/* Page header */}
      <div className="border-b border-[var(--color-line-strong)] bg-[var(--color-surface)] px-8 py-4">
        <h1 className="text-lg font-semibold text-[var(--color-ink)]">New Session</h1>
      </div>

      <div className="flex flex-1 items-start justify-center overflow-y-auto py-10" style={{ background: "var(--color-canvas)" }}>
        <div className="w-full max-w-xl px-8">

          {/* Config panel */}
          <div className="mb-6 border border-[var(--color-line-strong)] bg-[var(--color-surface)]">
            <div className="border-b border-[var(--color-line)] px-5 py-2.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
                Configuration
              </p>
            </div>

            <div className="divide-y divide-[var(--color-line)]">
              {/* Repository */}
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <label className="text-[13px] font-medium text-[var(--color-muted)]">Repository</label>
                <div className="flex items-center gap-2">
                  <SelectField value={repo} onChange={(v) => setRepo(v)} className="w-52">
                    {repos.length === 0 && <option value="">No repos configured</option>}
                    {repos.map((r) => <option key={r} value={r}>{r}</option>)}
                    <option value="__custom__">Custom…</option>
                  </SelectField>
                  {repo === "__custom__" && (
                    <input
                      value={customRepo}
                      onChange={(e) => setCustomRepo(e.target.value)}
                      placeholder="owner/repo"
                      style={{ background: "var(--color-surface)", color: "var(--color-ink)", borderColor: "var(--color-line-strong)" }}
                      className="w-36 border px-3 py-2 font-mono text-[12px] placeholder:text-[var(--color-faint)] focus:outline-none focus:border-[var(--color-accent)]"
                    />
                  )}
                </div>
              </div>

              {/* Task type */}
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <label className="text-[13px] font-medium text-[var(--color-muted)]">Task type</label>
                <SelectField value={profile} onChange={(v) => setProfile(v)} className="w-40">
                  <option value="general_agent">Agent task</option>
                  <option value="pr_review">PR review</option>
                </SelectField>
              </div>

              {/* Branch OR PR number */}
              {!isReview ? (
                <div className="flex items-center justify-between gap-4 px-5 py-3">
                  <label className="text-[13px] font-medium text-[var(--color-muted)]">Branch</label>
                  {/* Fixed width wrapper prevents layout shift when options load */}
                  <SelectField
                    value={branch}
                    onChange={(v) => setBranch(v)}
                    disabled={branchesLoading || branches.length === 0}
                    className="w-52"
                  >
                    {branchesLoading && <option value="">Loading…</option>}
                    {!branchesLoading && branches.length === 0 && (
                      <option value="">{branch || "default"}</option>
                    )}
                    {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                  </SelectField>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-4 px-5 py-3">
                  <label className="text-[13px] font-medium text-[var(--color-muted)]">PR number</label>
                  <input
                    value={prNumber}
                    onChange={(e) => setPrNumber(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="#"
                    style={{ background: "var(--color-surface)", color: "var(--color-ink)", borderColor: "var(--color-line-strong)" }}
                    className="w-24 border px-3 py-2 font-mono text-[12px] placeholder:text-[var(--color-faint)] focus:outline-none focus:border-[var(--color-accent)]"
                  />
                </div>
              )}

              {/* Model */}
              {config && (config.available_models ?? []).length > 0 && (
                <div className="flex items-center justify-between gap-4 px-5 py-3">
                  <label className="text-[13px] font-medium text-[var(--color-muted)]">Model</label>
                  <SelectField value={model} onChange={(v) => setModel(v)} className="w-52">
                    {(config.available_models ?? []).map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </SelectField>
                </div>
              )}
            </div>
          </div>

          {/* Prompt */}
          <div className="mb-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
              {isReview ? "Reviewer note (optional)" : "Task prompt"}
            </p>
            <ChatComposer
              value={prompt}
              onChange={setPrompt}
              onSubmit={submit}
              placeholder={
                isReview
                  ? "Optional note for the reviewer…"
                  : `Describe the task — e.g. "What is this repo about?"`
              }
              model={config?.available_models?.find((m) => m.id === model)?.label ?? config?.model}
              submitLabel="Start"
              submitting={submitting}
              disabled={!effectiveRepo}
              autoFocus
            />
          </div>

          {error && (
            <div className="border border-red-500/30 bg-red-500/8 px-4 py-3 font-mono text-[12px] text-red-400">
              ERROR: {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SelectField({
  value,
  onChange,
  disabled,
  className = "",
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ background: "var(--color-surface)", color: "var(--color-ink)", borderColor: "var(--color-line-strong)" }}
        className="w-full appearance-none border px-3 py-2 pr-8 font-mono text-[12px] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-40"
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-faint)]">
        <svg viewBox="0 0 10 6" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M1 1l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}
