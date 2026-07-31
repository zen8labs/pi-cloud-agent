"use client";

import type { ConfigResponse, ProfileInfo, RepoConfigResponse } from "@pi-cloud-agent/protocol";
import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface JsonSchemaField {
  type?: string;
  default?: unknown;
  description?: string;
  items?: { type?: string };
}

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
      setError(null);
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
    <div className="page-scroll">
      <div className="page-wrap max-w-4xl">
        <header>
          <p className="eyebrow">Controller</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em]">Settings</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Runtime configuration is read from the controller. Profile options below are
            generated directly from each profile’s JSON Schema.
          </p>
        </header>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <section className="surface-card mt-8 overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-medium">Agent runtime</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Shared defaults for every new session.
            </p>
          </div>
          <div className="flex items-center justify-between gap-5 px-5 py-4">
            <div>
              <div className="text-sm">Model</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Configured with AGENT_MODEL and recorded per run.
              </div>
            </div>
            <code className="rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">
              {config?.model ?? "Loading…"}
            </code>
          </div>
        </section>

        {stored === null && !error && (
          <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            Loading repository settings…
          </div>
        )}
        {stored?.repos.length === 0 && (
          <div className="surface-card mt-8 px-5 py-5 text-sm text-muted-foreground">
            No repositories are configured. Set{" "}
            <code className="font-mono text-foreground">WEB_REPOS</code> or install the GitHub
            App.
          </div>
        )}

        {stored &&
          configurable.map((profile) => (
            <section key={profile.name} className="mt-8">
              <div className="mb-3">
                <h2 className="text-sm font-medium">{profile.name}</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {profile.description}
                </p>
              </div>
              <div className="surface-card divide-y divide-border overflow-hidden">
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
  );
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

  return (
    <div className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(180px,1fr)_minmax(0,2fr)_24px] lg:items-center">
      <span className="truncate font-mono text-xs">{repo}</span>
      <div className="flex flex-wrap items-center gap-3">
        {Object.entries(properties(profile)).map(([key, field]) => (
          <FieldControl
            key={key}
            name={key}
            field={field}
            value={value[key]}
            disabled={state === "saving"}
            onChange={(next) => void save({ ...value, [key]: next })}
          />
        ))}
      </div>
      <SaveState state={state} />
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
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        disabled={disabled}
        title={field.description}
        className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground disabled:opacity-50"
      >
        <span
          className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-primary" : "bg-muted"}`}
        >
          <span
            className={`absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`}
          />
        </span>
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
              .filter(Boolean),
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
    <label className="grid gap-1.5 text-xs text-muted-foreground">
      {label(name)}
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
        className="h-8 w-44 rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
      />
    </label>
  );
}

function SaveState({ state }: { state: "idle" | "saving" | "saved" | "failed" }) {
  if (state === "idle") return null;
  if (state === "saving")
    return (
      <LoaderCircleIcon
        className="size-4 animate-spin text-muted-foreground"
        aria-label="Saving"
      />
    );
  if (state === "saved")
    return <CheckIcon className="size-4 text-emerald-500" aria-label="Saved" />;
  return <XIcon className="size-4 text-destructive" aria-label="Save failed" />;
}
