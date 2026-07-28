"use client";

import type { ConfigResponse, ProfileInfo, RepoConfigResponse } from "@pi-cloud-agent/protocol";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * Per-repository settings, rendered from each profile's own schema.
 *
 * There is no form here describing what a pull request review can be configured
 * with — the controller sends the profile's JSON Schema and this page renders
 * whatever it finds. That is the visible half of keeping profile settings out of
 * the core: a new profile's options appear here with no change to the dashboard,
 * the API, or the database.
 */
export default function SettingsPage() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [stored, setStored] = useState<RepoConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loadedConfig, loadedStored] = await Promise.all([
        api.getConfig(),
        api.getRepoConfig(),
      ]);
      setConfig(loadedConfig);
      setStored(loadedStored);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const configurable = (config?.profiles ?? []).filter(
    (profile) => Object.keys(properties(profile)).length > 0,
  );

  return (
    <div
      className="flex h-screen flex-col overflow-hidden"
      style={{ background: "var(--color-canvas)" }}
    >
      <div className="border-b border-[var(--color-line-strong)] bg-[var(--color-surface)] px-8 py-4">
        <h1 className="text-lg font-semibold text-[var(--color-ink)]">Settings</h1>
      </div>

      <div
        className="flex-1 overflow-y-auto px-8 py-8"
        style={{ background: "var(--color-canvas)" }}
      >
        <div className="max-w-3xl">
          <section className="mb-8">
            <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
              Model
            </p>
            <div className="border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-5 py-4">
              <p className="font-mono text-[12px] text-[var(--color-ink)]">
                {config?.model ?? "—"}
              </p>
              <p className="mt-1 text-[12px] text-[var(--color-muted)]">
                One model, configured with <span className="font-mono">AGENT_MODEL</span>. Every
                run records the model it used, so changing this does not rewrite history.
              </p>
            </div>
          </section>

          {error && (
            <div className="mb-6 border border-red-500/30 bg-red-500/8 px-4 py-3 font-mono text-[12px] text-red-400">
              {error}
            </div>
          )}

          {stored === null && !error && (
            <p className="font-mono text-[12px] text-[var(--color-faint)]">Loading…</p>
          )}

          {stored !== null && stored.repos.length === 0 && (
            <p className="font-mono text-[12px] text-[var(--color-muted)]">
              No repositories yet. Set{" "}
              <span className="text-[var(--color-ink)]">WEB_REPOS</span> or install the GitHub
              App.
            </p>
          )}

          {stored !== null &&
            configurable.map((profile) => (
              <section key={profile.name} className="mb-8">
                <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
                  {profile.name}
                </p>
                <p className="mb-4 text-[13px] text-[var(--color-muted)]">
                  {profile.description}
                </p>

                <div className="border border-[var(--color-line-strong)] bg-[var(--color-surface)]">
                  {stored.repos.map((repo) => (
                    <RepoRow
                      key={`${profile.name}:${repo}`}
                      repo={repo}
                      profile={profile}
                      initial={
                        stored.entries.find(
                          (entry) => entry.repo === repo && entry.profile === profile.name,
                        )?.config ?? defaults(profile)
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}

/* ── schema helpers ────────────────────────────────────────────────────────── */

interface JsonSchemaField {
  type?: string;
  default?: unknown;
  description?: string;
  items?: { type?: string };
}

function properties(profile: ProfileInfo): Record<string, JsonSchemaField> {
  const schema = profile.configJsonSchema as { properties?: Record<string, JsonSchemaField> };
  return schema.properties ?? {};
}

function defaults(profile: ProfileInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(properties(profile))) {
    if (field.default !== undefined) result[key] = field.default;
  }
  return result;
}

function label(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (character) => character.toUpperCase())
    .trim();
}

/* ── rows ──────────────────────────────────────────────────────────────────── */

function RepoRow({
  repo,
  profile,
  initial,
}: {
  repo: string;
  profile: ProfileInfo;
  initial: Record<string, unknown>;
}) {
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const save = async (next: Record<string, unknown>) => {
    const previous = value;
    setValue(next);
    setState("saving");
    try {
      await api.setRepoConfig({ repo, profile: profile.name, config: next });
      setState("saved");
    } catch {
      setValue(previous);
      setState("failed");
    }
  };

  const fields = Object.entries(properties(profile));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3 transition-colors last:border-b-0 hover:bg-[var(--color-surface-2)]">
      <span className="truncate font-mono text-[12px] text-[var(--color-ink)]">{repo}</span>

      <div className="flex flex-wrap items-center gap-3">
        {fields.map(([key, field]) => (
          <FieldControl
            key={key}
            name={key}
            field={field}
            value={value[key]}
            disabled={state === "saving"}
            onChange={(next) => void save({ ...value, [key]: next })}
          />
        ))}
        <SaveState state={state} />
      </div>
    </div>
  );
}

function FieldControl({
  name,
  field,
  value,
  disabled,
  onChange,
}: {
  name: string;
  field: JsonSchemaField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "boolean") {
    const on = value !== false;
    return (
      <button
        type="button"
        onClick={() => onChange(!on)}
        disabled={disabled}
        title={field.description ?? `${on ? "Disable" : "Enable"} ${label(name)}`}
        style={{
          background: on ? "var(--color-accent)" : "var(--color-surface)",
          color: on ? "var(--color-canvas)" : "var(--color-faint)",
          borderColor: on ? "var(--color-accent)" : "var(--color-line-strong)",
        }}
        className="border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors disabled:opacity-40"
      >
        {label(name)}
      </button>
    );
  }

  if (field.type === "array") {
    return (
      <TextControl
        name={name}
        placeholder="comma separated"
        disabled={disabled}
        value={Array.isArray(value) ? value.join(", ") : ""}
        onCommit={(text) =>
          onChange(
            text
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item.length > 0),
          )
        }
      />
    );
  }

  return (
    <TextControl
      name={name}
      placeholder={label(name).toLowerCase()}
      disabled={disabled}
      value={typeof value === "string" ? value : ""}
      onCommit={onChange}
    />
  );
}

/** Commit on blur or Enter rather than per keystroke: one save per intent. */
function TextControl({
  name,
  value,
  placeholder,
  disabled,
  onCommit,
}: {
  name: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <input
      aria-label={label(name)}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      style={{
        background: "var(--color-surface)",
        color: "var(--color-ink)",
        borderColor: "var(--color-line-strong)",
      }}
      className="w-40 border px-3 py-1.5 font-mono text-[11px] placeholder:text-[var(--color-faint)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-40"
    />
  );
}

function SaveState({ state }: { state: "idle" | "saving" | "saved" | "failed" }) {
  if (state === "idle") return <span className="w-12" />;
  const text = state === "saving" ? "saving…" : state === "saved" ? "saved" : "failed";
  const color =
    state === "failed"
      ? "text-red-400"
      : state === "saved"
        ? "text-[var(--color-accent)]"
        : "text-[var(--color-faint)]";
  return <span className={`w-12 font-mono text-[11px] ${color}`}>{text}</span>;
}
