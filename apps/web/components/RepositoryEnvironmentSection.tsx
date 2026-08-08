"use client";

import type { RepositoryEnvironmentSummary, VcsRepository } from "@pi-cloud-agent/protocol";
import { CheckCircle2Icon, LoaderCircleIcon, TerminalSquareIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

export function RepositoryEnvironmentSection({ onNotice }: { onNotice: NoticeHandler }) {
  const [repos, setRepos] = useState<VcsRepository[]>([]);
  const [environments, setEnvironments] = useState<RepositoryEnvironmentSummary[]>([]);
  const [selectedRepoKey, setSelectedRepoKey] = useState("");
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const environmentByRepo = useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          `${environment.provider}:${environment.repo}`,
          environment,
        ]),
      ),
    [environments],
  );

  useEffect(() => {
    Promise.all([api.listRepos(), api.listRepositoryEnvironments()])
      .then(([loadedRepos, loadedEnvironments]) => {
        setRepos(loadedRepos);
        setEnvironments(loadedEnvironments);
        setSelectedRepoKey(
          (current) => current || (loadedRepos[0] ? repoKey(loadedRepos[0]) : ""),
        );
      })
      .catch((cause) =>
        onNotice(cause instanceof Error ? cause.message : String(cause), "error"),
      )
      .finally(() => setLoading(false));
  }, [onNotice]);

  const selected = repos.find((repo) => repoKey(repo) === selectedRepoKey);
  const configured = selected ? environmentByRepo.get(repoKey(selected)) : null;

  useEffect(() => {
    setScript(configured?.setupScript ?? "");
  }, [configured?.setupScript]);

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api.saveRepositoryEnvironment({
        provider: selected.provider,
        repo: selected.fullName,
        setupScript: script,
      });
      setEnvironments((current) => {
        const key = repoKey(selected);
        const next = current.filter(
          (environment) => `${environment.provider}:${environment.repo}` !== key,
        );
        return result.environment ? [...next, result.environment] : next;
      });
      onNotice(
        script.trim()
          ? "Environment setup saved."
          : "Environment setup cleared; only bundled image tools will be used.",
        "success",
      );
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="mb-4 flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
          <TerminalSquareIcon className="size-4 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-sm font-medium">Repository environments</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Add the setup commands this repository needs before an agent starts. This setting is
            saved per repository and runs before the agent starts.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> Loading repositories…
        </div>
      ) : repos.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
          Connect a Git provider to configure repository environments.
        </p>
      ) : (
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <label
            className="block text-xs font-medium text-muted-foreground"
            htmlFor="environment-repo"
          >
            Repository
          </label>
          <select
            id="environment-repo"
            value={selectedRepoKey}
            onChange={(event) => setSelectedRepoKey(event.target.value)}
            className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {repos.map((repo) => (
              <option key={repoKey(repo)} value={repoKey(repo)}>
                {repo.fullName}
              </option>
            ))}
          </select>
          <div>
            <label
              className="block text-xs font-medium text-muted-foreground"
              htmlFor="environment-script"
            >
              Setup script
            </label>
            <Textarea
              id="environment-script"
              value={script}
              onChange={(event) => setScript(event.target.value)}
              placeholder={`pnpm install\npython3 -m venv .venv`}
              className="mt-2 min-h-32 resize-y font-mono text-xs leading-5"
              spellCheck={false}
            />
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Runs as the unprivileged sandbox user after checkout, with a five-minute limit.
              Keep it non-interactive and idempotent. Leave empty to use only the bundled image
              tools.
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {configured && <CheckCircle2Icon className="size-3.5 text-emerald-500" />}
              {configured ? "Custom setup enabled" : "Bundled image only"}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => void save()}
              disabled={busy || !selected}
            >
              {busy && <LoaderCircleIcon className="animate-spin" />}
              {busy ? "Saving…" : "Save setup"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

type NoticeHandler = (message: string, kind: "success" | "error") => void;

function repoKey(repo: Pick<VcsRepository, "provider" | "fullName">): string {
  return `${repo.provider}:${repo.fullName}`;
}
