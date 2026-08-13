"use client";

import type { RepositoryEnvironmentSummary, VcsRepository } from "@pi-cloud-agent/protocol";
import {
  CheckCircle2Icon,
  CircleXIcon,
  LoaderCircleIcon,
  PlayIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

export function RepositoryEnvironmentSection({ onNotice }: { onNotice: NoticeHandler }) {
  const [repos, setRepos] = useState<VcsRepository[]>([]);
  const [environments, setEnvironments] = useState<RepositoryEnvironmentSummary[]>([]);
  const [selectedRepoKey, setSelectedRepoKey] = useState("");
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

      {loading && <LoadingRepositories />}
      {!loading && repos.length === 0 && <NoConnectedRepositories />}
      {!loading && selected && (
        <EnvironmentEditor
          key={selectedRepoKey}
          configured={configured}
          repo={selected}
          repos={repos}
          selectedRepoKey={selectedRepoKey}
          onNotice={onNotice}
          onRepositoryChange={setSelectedRepoKey}
          onSaved={(environment) => {
            setEnvironments((current) => {
              const key = repoKey(selected);
              const next = current.filter((item) => `${item.provider}:${item.repo}` !== key);
              return environment ? [...next, environment] : next;
            });
          }}
        />
      )}
    </section>
  );
}

function LoadingRepositories() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" /> Loading repositories…
    </div>
  );
}

function NoConnectedRepositories() {
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
      Connect a Git provider to configure repository environments.
    </p>
  );
}

function EnvironmentEditor({
  configured,
  repo,
  repos,
  selectedRepoKey,
  onNotice,
  onRepositoryChange,
  onSaved,
}: {
  configured: RepositoryEnvironmentSummary | null | undefined;
  repo: VcsRepository;
  repos: VcsRepository[];
  selectedRepoKey: string;
  onNotice: NoticeHandler;
  onRepositoryChange: (key: string) => void;
  onSaved: (environment: RepositoryEnvironmentSummary | undefined) => void;
}) {
  const [script, setScript] = useState(configured?.setupScript ?? "");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; output: string } | null>(null);

  useEffect(() => {
    setScript(configured?.setupScript ?? "");
    setTestResult(null);
  }, [configured?.setupScript]);

  const test = async () => {
    if (!script.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await api.testRepositoryEnvironment({
          provider: repo.provider,
          repo: repo.fullName,
          setupScript: script,
        }),
      );
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.saveRepositoryEnvironment({
        provider: repo.provider,
        repo: repo.fullName,
        setupScript: script,
      });
      onSaved(result.environment);
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
        onChange={(event) => onRepositoryChange(event.target.value)}
        className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {repos.map((item) => (
          <option key={repoKey(item)} value={repoKey(item)}>
            {item.fullName}
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
          placeholder={`pnpm install\npython -m pip install -r requirements.txt`}
          className="mt-2 min-h-32 resize-y font-mono text-xs leading-5"
          spellCheck={false}
        />
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Runs as the unprivileged sandbox user after checkout, with a five-minute limit. Test
          it in a disposable sandbox before saving.
        </p>
      </div>
      {testResult && <SetupTestResult result={testResult} />}
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {configured && <CheckCircle2Icon className="size-3.5 text-emerald-500" />}
          {configured ? "Custom setup enabled" : "Bundled image only"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void test()}
            disabled={busy || testing || !script.trim()}
          >
            {testing ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
            {testing ? "Testing…" : "Test setup"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={busy || testing}
          >
            {busy && <LoaderCircleIcon className="animate-spin" />}
            {busy ? "Saving…" : "Save setup"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SetupTestResult({ result }: { result: { ok: boolean; output: string } }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${
        result.ok
          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
          : "border-destructive/30 bg-destructive/5 text-destructive"
      }`}
    >
      <div className="flex items-center gap-1.5 font-medium">
        {result.ok ? (
          <CheckCircle2Icon className="size-3.5" />
        ) : (
          <CircleXIcon className="size-3.5" />
        )}
        {result.ok ? "Setup test passed" : "Setup test failed"}
      </div>
      {result.output && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 opacity-90">
          {result.output}
        </pre>
      )}
    </div>
  );
}

type NoticeHandler = (message: string, kind: "success" | "error") => void;

function repoKey(repo: Pick<VcsRepository, "provider" | "fullName">): string {
  return `${repo.provider}:${repo.fullName}`;
}
