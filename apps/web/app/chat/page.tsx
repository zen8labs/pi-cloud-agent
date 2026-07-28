"use client";

import type { ConfigResponse } from "@pi-cloud-agent/protocol";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ChatComposer } from "@/components/ChatComposer";
import { api } from "@/lib/api";

export default function ChatPage() {
  return (
    <Suspense>
      <NewSession />
    </Suspense>
  );
}

/**
 * Start a run.
 *
 * The profile list comes from the controller rather than being written here, so
 * a new profile shows up in this form without touching the dashboard. Which
 * fields a profile needs is the one thing this page still knows: a review needs a
 * pull request, everything else needs a prompt.
 */
function NewSession() {
  const router = useRouter();
  const params = useSearchParams();

  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState(params.get("repo") ?? "");
  const [customRepo, setCustomRepo] = useState("");
  const [profile, setProfile] = useState(params.get("profile") ?? "");
  const [prNumber, setPrNumber] = useState("");
  const [prompt, setPrompt] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listRepos()
      .then(setRepos)
      .catch(() => setRepos([]));
    api
      .getConfig()
      .then((loaded) => {
        setConfig(loaded);
        setProfile((current) => current || loaded.defaultProfile);
      })
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    if (!repo && repos.length > 0) setRepo(repos[0] ?? "");
  }, [repos, repo]);

  const effectiveRepo = repo === "__custom__" ? customRepo.trim() : repo;

  useEffect(() => {
    if (!effectiveRepo.includes("/")) {
      setBranches([]);
      setBranch("");
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    api
      .listBranches(effectiveRepo)
      .then((result) => {
        if (cancelled) return;
        setBranches(result.branches);
        setBranch(result.default ?? result.branches[0] ?? "");
      })
      .catch(() => {
        if (!cancelled) {
          setBranches([]);
          setBranch("");
        }
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveRepo]);

  const needsPullRequest = profile === "pr-review";
  const canSubmit =
    Boolean(effectiveRepo) &&
    (needsPullRequest ? prNumber.trim().length > 0 : prompt.trim().length > 0) &&
    !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await api.createRun({
        repo: effectiveRepo,
        profile,
        prompt: prompt.trim() || "Review this pull request.",
        branch: branch || null,
        prNumber: needsPullRequest ? Number(prNumber) : null,
      });
      router.push(`/sessions/${run.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  const activeProfile = config?.profiles.find((entry) => entry.name === profile);

  return (
    <div className="flex h-screen flex-col" style={{ background: "var(--color-canvas)" }}>
      <div className="border-b border-[var(--color-line-strong)] bg-[var(--color-surface)] px-8 py-4">
        <h1 className="text-lg font-semibold text-[var(--color-ink)]">New Session</h1>
      </div>

      <div
        className="flex flex-1 items-start justify-center overflow-y-auto py-10"
        style={{ background: "var(--color-canvas)" }}
      >
        <div className="w-full max-w-xl px-8">
          <div className="mb-6 border border-[var(--color-line-strong)] bg-[var(--color-surface)]">
            <div className="border-b border-[var(--color-line)] px-5 py-2.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
                Configuration
              </p>
            </div>

            <div className="divide-y divide-[var(--color-line)]">
              <Field label="Repository">
                <div className="flex items-center gap-2">
                  <Select value={repo} onChange={setRepo} className="w-52">
                    {repos.length === 0 && <option value="">No repositories found</option>}
                    {repos.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                    <option value="__custom__">Custom…</option>
                  </Select>
                  {repo === "__custom__" && (
                    <input
                      value={customRepo}
                      onChange={(event) => setCustomRepo(event.target.value)}
                      placeholder="owner/repo"
                      style={{
                        background: "var(--color-surface)",
                        color: "var(--color-ink)",
                        borderColor: "var(--color-line-strong)",
                      }}
                      className="w-36 border px-3 py-2 font-mono text-[12px] placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)] focus:outline-none"
                    />
                  )}
                </div>
              </Field>

              <Field label="Profile">
                <Select value={profile} onChange={setProfile} className="w-52">
                  {(config?.profiles ?? []).map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              </Field>

              {needsPullRequest ? (
                <Field label="Pull request">
                  <input
                    value={prNumber}
                    onChange={(event) => setPrNumber(event.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="#"
                    style={{
                      background: "var(--color-surface)",
                      color: "var(--color-ink)",
                      borderColor: "var(--color-line-strong)",
                    }}
                    className="w-24 border px-3 py-2 font-mono text-[12px] placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </Field>
              ) : (
                <Field label="Branch">
                  <Select
                    value={branch}
                    onChange={setBranch}
                    disabled={branchesLoading || branches.length === 0}
                    className="w-52"
                  >
                    {branchesLoading && <option value="">Loading…</option>}
                    {!branchesLoading && branches.length === 0 && (
                      <option value="">{branch || "default"}</option>
                    )}
                    {branches.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>

            {activeProfile && (
              <div className="border-t border-[var(--color-line)] px-5 py-3">
                <p className="text-[12px] text-[var(--color-muted)]">
                  {activeProfile.description}
                </p>
              </div>
            )}
          </div>

          <div className="mb-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
              {needsPullRequest ? "Reviewer note (optional)" : "Task"}
            </p>
            <ChatComposer
              value={prompt}
              onChange={setPrompt}
              onSubmit={submit}
              placeholder={
                needsPullRequest
                  ? "Optional note for the reviewer…"
                  : 'Describe the task — e.g. "What is this repository about?"'
              }
              model={config?.model}
              submitLabel="Start"
              submitting={submitting}
              disabled={!effectiveRepo}
              autoFocus
            />
          </div>

          {error && (
            <div className="border border-red-500/30 bg-red-500/8 px-4 py-3 font-mono text-[12px] text-red-400">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <span className="text-[13px] font-medium text-[var(--color-muted)]">{label}</span>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  disabled,
  className = "",
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        style={{
          background: "var(--color-surface)",
          color: "var(--color-ink)",
          borderColor: "var(--color-line-strong)",
        }}
        className="w-full appearance-none border px-3 py-2 pr-8 font-mono text-[12px] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-40"
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-faint)]">
        <svg
          viewBox="0 0 10 6"
          className="h-2.5 w-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M1 1l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}
