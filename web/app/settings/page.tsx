"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ModelOption, RepoBranch, RepoTriggers } from "@/lib/types";

export default function SettingsPage() {
  const [repos, setRepos] = useState<RepoBranch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSavedAt, setModelSavedAt] = useState(0);
  const [modelError, setModelError] = useState(false);

  useEffect(() => {
    api
      .listRepoBranches()
      .then(setRepos)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api
      .getDefaultModel()
      .then(({ model, available_models }) => {
        setDefaultModel(model);
        setAvailableModels(available_models);
      })
      .catch(() => {});
  }, []);

  const onModelChange = async (value: string) => {
    const prev = defaultModel;
    setDefaultModel(value);
    setModelSaving(true);
    setModelError(false);
    try {
      await api.setDefaultModel(value);
      setModelSavedAt(Date.now());
    } catch {
      setDefaultModel(prev);
      setModelError(true);
    } finally {
      setModelSaving(false);
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: "var(--color-canvas)" }}>
      {/* Page header */}
      <div className="border-b border-[var(--color-line-strong)] bg-[var(--color-surface)] px-8 py-4">
        <h1 className="text-lg font-semibold text-[var(--color-ink)]">Settings</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-8" style={{ background: "var(--color-canvas)" }}>
        <div className="max-w-2xl">

          {/* Default model */}
          {availableModels.length > 0 && (
            <div className="mb-8">
              <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
                Default Model
              </p>
              <div className="border border-[var(--color-line-strong)] bg-[var(--color-surface)]">
                <div className="flex items-center justify-between gap-4 px-5 py-4">
                  <div>
                    <p className="text-[13px] font-medium text-[var(--color-ink)]">
                      Headless tasks (PR review)
                    </p>
                    <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
                      Applied when a run is triggered automatically with no per-session model selection.
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {modelSaving && (
                      <span className="font-mono text-[11px] text-[var(--color-faint)]">saving…</span>
                    )}
                    {!modelSaving && modelError && (
                      <span className="font-mono text-[11px] text-red-400">failed</span>
                    )}
                    {!modelSaving && !modelError && Date.now() - modelSavedAt < 2000 && modelSavedAt > 0 && (
                      <span className="font-mono text-[11px] text-[var(--color-accent)]">saved</span>
                    )}
                    <StyledSelect
                      value={defaultModel}
                      onChange={(e) => onModelChange(e.target.value)}
                      disabled={modelSaving}
                    >
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </StyledSelect>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* PR-review repos: triggers + branch */}
          <div>
            <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
              PR-Review Repositories
            </p>
            <p className="mb-4 text-[13px] text-[var(--color-muted)]">
              Choose which webhook events auto-start a review per repo
              (<span className="font-mono text-[var(--color-ink)]">Opened</span>,{" "}
              <span className="font-mono text-[var(--color-ink)]">Sync</span> = new commits pushed,{" "}
              <span className="font-mono text-[var(--color-ink)]">Comment</span> = <span className="font-mono">/review</span>),
              and pin the branch the agent clones (<span className="font-mono text-[var(--color-ink)]">Default branch</span> tracks the repo default).
            </p>

            {error && (
              <div className="mb-4 border border-red-500/30 bg-red-500/8 px-4 py-3 font-mono text-[12px] text-red-400">
                ERROR: {error}
              </div>
            )}

            {repos === null && !error && (
              <p className="font-mono text-[12px] text-[var(--color-faint)]">Loading repositories…</p>
            )}

            {repos !== null && repos.length === 0 && (
              <p className="font-mono text-[12px] text-[var(--color-muted)]">
                No connected repos. Configure <span className="text-[var(--color-ink)]">WEB_REPOS</span> or install the GitHub App.
              </p>
            )}

            {repos !== null && repos.length > 0 && (
              <div className="border border-[var(--color-line-strong)] bg-[var(--color-surface)]">
                <div className="flex items-center justify-between border-b border-[var(--color-line-strong)] bg-[var(--color-surface-2)] px-5 py-2.5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                    Repository
                  </span>
                  <div className="flex items-center gap-6">
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                      Triggers
                    </span>
                    <span className="w-52 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-faint)]">
                      PR-Review Branch
                    </span>
                  </div>
                </div>

                {repos.map((r) => (
                  <RepoBranchRow
                    key={r.repo}
                    repo={r.repo}
                    initialBranch={r.branch}
                    initialTriggers={r.triggers}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StyledSelect({
  value,
  onChange,
  disabled,
  children,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative w-52">
      <select
        value={value}
        onChange={onChange}
        disabled={disabled}
        style={{ background: "var(--color-surface)", color: "var(--color-ink)", borderColor: "var(--color-line-strong)" }}
        className="w-full appearance-none border px-3 py-2 pr-8 font-mono text-[12px] focus:outline-none disabled:opacity-40"
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

function TriggerToggle({
  label,
  on,
  onClick,
  disabled,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={`${on ? "Disable" : "Enable"} review on ${label}`}
      style={{
        background: on ? "var(--color-accent)" : "var(--color-surface)",
        color: on ? "var(--color-canvas)" : "var(--color-faint)",
        borderColor: on ? "var(--color-accent)" : "var(--color-line-strong)",
      }}
      className="border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function RepoBranchRow({
  repo,
  initialBranch,
  initialTriggers,
}: {
  repo: string;
  initialBranch: string;
  initialTriggers: RepoTriggers;
}) {
  const [branch, setBranch] = useState(initialBranch);
  const [triggers, setTriggers] = useState(initialTriggers);
  const [options, setOptions] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState(false);

  const toggleTrigger = async (key: keyof RepoTriggers) => {
    const prev = triggers;
    const next = { ...triggers, [key]: !triggers[key] };
    setTriggers(next);
    setSaving(true);
    setError(false);
    try {
      await api.setRepoTriggers(repo, next);
      setSavedAt(Date.now());
    } catch {
      setTriggers(prev);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const loadBranches = () => {
    if (options !== null || loading) return;
    setLoading(true);
    api
      .listBranches(repo)
      .then(({ branches }) => setOptions(branches))
      .catch(() => setOptions([]))
      .finally(() => setLoading(false));
  };

  const onChange = async (value: string) => {
    const prev = branch;
    setBranch(value);
    setSaving(true);
    setError(false);
    try {
      await api.setRepoBranch(repo, value);
      setSavedAt(Date.now());
    } catch {
      setBranch(prev);
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const opts = options ?? (branch ? [branch] : []);

  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-3 last:border-b-0 transition-colors hover:bg-[var(--color-surface-2)]">
      <span className="truncate font-mono text-[12px] text-[var(--color-ink)]">{repo}</span>
      <div className="flex shrink-0 items-center gap-6">
        <div className="flex items-center gap-3">
          <TriggerToggle label="Opened" on={triggers.opened} onClick={() => toggleTrigger("opened")} disabled={saving} />
          <TriggerToggle label="Sync" on={triggers.synchronize} onClick={() => toggleTrigger("synchronize")} disabled={saving} />
          <TriggerToggle label="Comment" on={triggers.comment} onClick={() => toggleTrigger("comment")} disabled={saving} />
        </div>
        {saving && <span className="font-mono text-[11px] text-[var(--color-faint)]">saving…</span>}
        {!saving && error && <span className="font-mono text-[11px] text-red-400">failed</span>}
        {!saving && !error && Date.now() - savedAt < 2000 && savedAt > 0 && (
          <span className="font-mono text-[11px] text-[var(--color-accent)]">saved</span>
        )}
        {/* Fixed-width wrapper prevents layout shift when branch list loads */}
        <div className="relative w-52">
          <select
            value={branch}
            onFocus={loadBranches}
            onMouseDown={loadBranches}
            onChange={(e) => onChange(e.target.value)}
            disabled={saving}
            style={{ background: "var(--color-surface)", color: "var(--color-ink)", borderColor: "var(--color-line-strong)" }}
            className="w-full appearance-none border px-3 py-2 pr-8 font-mono text-[12px] focus:outline-none disabled:opacity-40"
          >
            <option value="">Default branch</option>
            {loading && <option disabled>Loading…</option>}
            {opts.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-faint)]">
            <svg viewBox="0 0 10 6" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 1l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
