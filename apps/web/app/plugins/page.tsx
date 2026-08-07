"use client";

import type { PluginCatalogEntry } from "@pi-cloud-agent/protocol";
import { PuzzleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginCatalogEntry[]>([]);
  const [isOperator, setIsOperator] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [variableDrafts, setVariableDrafts] = useState<Record<string, Record<string, string>>>(
    {},
  );

  const reload = useCallback(async () => {
    const response = await api.listPlugins();
    setPlugins(response.plugins);
    setIsOperator(response.isOperator);
  }, []);

  useEffect(() => {
    void reload().catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [reload]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (!oauth) return;
    const message = params.get("message");
    if (oauth === "connected") {
      setError(null);
    } else {
      setError(message ? `OAuth ${oauth}: ${message}` : `OAuth ${oauth}`);
    }
    window.history.replaceState({}, "", "/plugins");
    void reload().catch(() => undefined);
  }, [reload]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-start gap-3">
        <PuzzleIcon className="mt-1 size-5 text-muted-foreground" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Plugins</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Install marketplace plugins for skills and MCP tools. Attached skills are included
            in the task prompt.
          </p>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {isOperator && (
        <section className="mb-8 rounded-xl border border-border p-4">
          <h2 className="text-sm font-medium">Operator</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Seed packages from marketplace/plugins into the catalog.
          </p>
          <button
            type="button"
            className="mt-3 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
            disabled={busy === "seed"}
            onClick={() =>
              void run("seed", async () => {
                await api.seedPlugins();
              })
            }
          >
            {busy === "seed" ? "Seeding…" : "Seed catalog"}
          </button>
        </section>
      )}

      <ul className="space-y-4">
        {plugins.length === 0 && (
          <li className="text-sm text-muted-foreground">
            No plugins in the catalog yet.
            {isOperator ? " Use Seed catalog above." : " Ask an operator to publish one."}
          </li>
        )}
        {plugins.map((plugin) => (
          <PluginCard
            key={`${plugin.name}@${plugin.version}`}
            plugin={plugin}
            isOperator={isOperator}
            busy={busy}
            configuring={configuring === plugin.name}
            draft={variableDrafts[plugin.name] ?? {}}
            onRun={run}
            onToggleConfigure={() =>
              setConfiguring(configuring === plugin.name ? null : plugin.name)
            }
            onDraftChange={(name, value) =>
              setVariableDrafts((current) => ({
                ...current,
                [plugin.name]: { ...current[plugin.name], [name]: value },
              }))
            }
            onConfigured={() => setConfiguring(null)}
          />
        ))}
      </ul>
    </main>
  );
}

function PluginCard({
  plugin,
  isOperator,
  busy,
  configuring,
  draft,
  onRun,
  onToggleConfigure,
  onDraftChange,
  onConfigured,
}: {
  plugin: PluginCatalogEntry;
  isOperator: boolean;
  busy: string | null;
  configuring: boolean;
  draft: Record<string, string>;
  onRun: (key: string, action: () => Promise<void>) => Promise<void>;
  onToggleConfigure: () => void;
  onDraftChange: (name: string, value: string) => void;
  onConfigured: () => void;
}) {
  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PluginSummary plugin={plugin} />
        <PluginActions
          plugin={plugin}
          isOperator={isOperator}
          busy={busy}
          onRun={onRun}
          onToggleConfigure={onToggleConfigure}
          onCloseConfigure={onConfigured}
        />
      </div>
      {configuring && plugin.user.installed && (
        <ConfigureForm
          plugin={plugin}
          draft={draft}
          busy={busy === `config-${plugin.name}`}
          onChange={onDraftChange}
          onSave={() =>
            void onRun(`config-${plugin.name}`, async () => {
              await api.configurePlugin(plugin.name, draft);
              onConfigured();
            })
          }
        />
      )}
    </li>
  );
}

function PluginSummary({ plugin }: { plugin: PluginCatalogEntry }) {
  const components = [
    plugin.components.skills ? "skills" : null,
    plugin.components.mcp ? "mcp" : null,
    plugin.oauth.required ? (plugin.oauth.connected ? "oauth connected" : "oauth") : null,
    plugin.user.attached ? "attached" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <h3 className="text-sm font-semibold">{plugin.name}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        v{plugin.version} · {plugin.publisher} · {plugin.installMode.replaceAll("_", " ")}
        {plugin.reviewStatus !== "approved" ? ` · ${plugin.reviewStatus}` : ""}
      </p>
      {plugin.description && (
        <p className="mt-2 text-sm text-muted-foreground">{plugin.description}</p>
      )}
      <p className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        {components}
      </p>
    </div>
  );
}

function PluginActions({
  plugin,
  isOperator,
  busy,
  onRun,
  onToggleConfigure,
  onCloseConfigure,
}: {
  plugin: PluginCatalogEntry;
  isOperator: boolean;
  busy: string | null;
  onRun: (key: string, action: () => Promise<void>) => Promise<void>;
  onToggleConfigure: () => void;
  onCloseConfigure: () => void;
}) {
  const canManage = plugin.installMode !== "required";
  const installed = plugin.user.installed || plugin.installMode === "required";

  return (
    <div className="flex flex-wrap gap-2">
      {!installed && canManage && (
        <button
          type="button"
          className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
          disabled={busy === `install-${plugin.name}`}
          onClick={() =>
            void onRun(`install-${plugin.name}`, async () => {
              await api.installPlugin(plugin.name, true);
            })
          }
        >
          {busy === `install-${plugin.name}` ? "Installing…" : "Install"}
        </button>
      )}

      {installed && (
        <>
          {canManage && (
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              disabled={busy === `toggle-${plugin.name}`}
              onClick={() =>
                void onRun(`toggle-${plugin.name}`, async () => {
                  await api.installPlugin(plugin.name, !plugin.user.attached);
                })
              }
            >
              {plugin.user.attached ? "Disable" : "Enable"}
            </button>
          )}
          {plugin.oauth.required && plugin.oauth.connectPath && (
            <a
              href={api.connectPluginOAuthUrl(plugin.name)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium"
            >
              {plugin.oauth.connected ? "Reconnect" : "Connect"}
            </a>
          )}
          {(plugin.components.mcp || hasVariables(plugin.variables)) && (
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium"
              onClick={onToggleConfigure}
            >
              Configure
            </button>
          )}
          {canManage && (
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-destructive disabled:opacity-50"
              disabled={busy === `uninstall-${plugin.name}`}
              onClick={() =>
                void onRun(`uninstall-${plugin.name}`, async () => {
                  await api.uninstallPlugin(plugin.name);
                  onCloseConfigure();
                })
              }
            >
              Uninstall
            </button>
          )}
        </>
      )}

      {isOperator && (
        <>
          <select
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
            value={plugin.installMode}
            disabled={busy === `mode-${plugin.name}`}
            onChange={(event) =>
              void onRun(`mode-${plugin.name}`, async () => {
                await api.setPluginInstallMode(
                  plugin.name,
                  event.target.value as "default_off" | "default_on" | "required",
                );
              })
            }
          >
            <option value="default_off">Default Off</option>
            <option value="default_on">Default On</option>
            <option value="required">Required</option>
          </select>
          {plugin.reviewStatus === "approved" && (
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-destructive disabled:opacity-50"
              disabled={busy === `yank-${plugin.name}`}
              onClick={() =>
                void onRun(`yank-${plugin.name}`, async () => {
                  await api.reviewPlugin(plugin.name, plugin.version, "yanked");
                })
              }
            >
              Yank
            </button>
          )}
        </>
      )}
    </div>
  );
}

function hasVariables(variables: unknown): boolean {
  return Object.keys(variableProperties(variables)).length > 0;
}

function ConfigureForm({
  plugin,
  draft,
  busy,
  onChange,
  onSave,
}: {
  plugin: PluginCatalogEntry;
  draft: Record<string, string>;
  busy: boolean;
  onChange: (name: string, value: string) => void;
  onSave: () => void;
}) {
  const properties = variableProperties(plugin.variables);
  const names = Object.keys(properties);
  if (names.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">No variables to configure.</p>;
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      {plugin.oauth.required && plugin.oauth.connected && plugin.oauth.tokenVariable && (
        <p className="text-xs text-muted-foreground">
          Connected via OAuth ({plugin.oauth.tokenVariable}). Paste below only to override with
          an API key.
        </p>
      )}
      {names.map((name) => (
        <label key={name} className="block text-xs">
          <span className="font-medium">{properties[name]?.title ?? name}</span>
          {plugin.user.configuredVariables.includes(name) && (
            <span className="ml-2 text-muted-foreground">(saved)</span>
          )}
          {properties[name]?.description && (
            <span className="mt-0.5 block text-muted-foreground">
              {properties[name].description}
            </span>
          )}
          <input
            type="password"
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            placeholder={plugin.user.configuredVariables.includes(name) ? "••••••••" : ""}
            value={draft[name] ?? ""}
            onChange={(event) => onChange(name, event.target.value)}
            autoComplete="off"
          />
        </label>
      ))}
      <button
        type="button"
        className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
        disabled={busy}
        onClick={onSave}
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function variableProperties(
  variables: unknown,
): Record<string, { title?: string; description?: string }> {
  if (
    variables &&
    typeof variables === "object" &&
    "properties" in variables &&
    variables.properties &&
    typeof variables.properties === "object"
  ) {
    return variables.properties as Record<string, { title?: string; description?: string }>;
  }
  return {};
}
