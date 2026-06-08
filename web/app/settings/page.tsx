"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ModelOption, RepoBranch } from "@/lib/types";

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
    <div className="mx-auto max-w-2xl px-8 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {/* Default model — used for headless tasks (PR review) with no per-session override. */}
      {availableModels.length > 0 && (
        <div className="mt-8 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="border-b border-[var(--color-line)] px-5 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
            Default model
          </div>
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-sm font-medium">Headless tasks (PR review)</p>
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                Applied when a run is triggered automatically with no per-session model selection.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {modelSaving && <span className="text-xs text-[var(--color-faint)]">saving…</span>}
              {!modelSaving && modelError && <span className="text-xs text-red-600">failed</span>}
              {!modelSaving && !modelError && Date.now() - modelSavedAt < 2000 && modelSavedAt > 0 && (
                <span className="text-xs text-[var(--color-faint)]">saved</span>
              )}
              <select
                value={defaultModel}
                onChange={(e) => onModelChange(e.target.value)}
                disabled={modelSaving}
                className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-canvas)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60"
              >
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      <p className="mt-8 text-sm font-medium">PR-review branch</p>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Pick the branch the PR-review agent clones for each connected repo.
        Leave a repo on <span className="font-medium">Default branch</span> to
        track whatever its default is.
      </p>

      {error && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {repos === null && !error && (
        <p className="mt-8 text-sm text-[var(--color-muted)]">Loading…</p>
      )}

      {repos !== null && repos.length === 0 && (
        <p className="mt-8 text-sm text-[var(--color-muted)]">
          No connected repos. Configure <code>WEB_REPOS</code> or install the
          GitHub App.
        </p>
      )}

      {repos !== null && repos.length > 0 && (
        <div className="mt-8 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-faint)]">
            <span>Repository</span>
            <span>PR-review branch</span>
          </div>
          {repos.map((r) => (
            <RepoBranchRow key={r.repo} repo={r.repo} initialBranch={r.branch} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepoBranchRow({
  repo,
  initialBranch,
}: {
  repo: string;
  initialBranch: string;
}) {
  const [branch, setBranch] = useState(initialBranch);
  const [options, setOptions] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState(false);

  // Lazily fetch this repo's branches the first time the selector is opened —
  // avoids hammering the VCS API for every repo on page load.
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
      setBranch(prev); // revert on failure
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  // Keep the saved value selectable even before the branch list has loaded.
  const opts = options ?? (branch ? [branch] : []);

  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-3 last:border-b-0">
      <span className="truncate font-mono text-sm">{repo}</span>
      <div className="flex items-center gap-2">
        {saving && <span className="text-xs text-[var(--color-faint)]">saving…</span>}
        {!saving && error && <span className="text-xs text-red-600">failed</span>}
        {!saving && !error && Date.now() - savedAt < 2000 && savedAt > 0 && (
          <span className="text-xs text-[var(--color-faint)]">saved</span>
        )}
        <select
          value={branch}
          onFocus={loadBranches}
          onMouseDown={loadBranches}
          onChange={(e) => onChange(e.target.value)}
          disabled={saving}
          className="max-w-[16rem] rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-canvas)] px-3 py-1.5 font-mono text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60"
        >
          <option value="">Default branch</option>
          {loading && <option disabled>Loading…</option>}
          {opts.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
