"use client";

import type { RepositoryEnvironmentSummary, VcsRepository } from "@pi-cloud-agent/protocol";
import {
  CheckCircle2Icon,
  CircleXIcon,
  LoaderCircleIcon,
  PlayIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { InfoTooltip } from "./LlmConnectionSupport";

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
          <h3 className="text-sm font-medium">Starting environment</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Choose the project environment for new sessions in this repository. The app adds its
            agent runtime and manages the checkout and session checkpoint.
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
  const [imageRef, setImageRef] = useState(configured?.imageRef ?? "");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; output: string } | null>(null);

  useEffect(() => {
    setImageRef(configured?.imageRef ?? "");
    setTestResult(null);
  }, [configured?.imageRef]);

  const test = async () => {
    if (!imageRef.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await api.testRepositoryEnvironment({
          provider: repo.provider,
          repo: repo.fullName,
          imageRef,
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
        imageRef,
      });
      onSaved(result.environment);
      onNotice(
        imageRef.trim()
          ? "Starting environment saved."
          : "Starting environment cleared; new sessions will use the default environment.",
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
      <span
        className="block text-xs font-medium text-muted-foreground"
        id="environment-repo-label"
      >
        Repository
      </span>
      <Select value={selectedRepoKey} onValueChange={(next) => onRepositoryChange(next ?? "")}>
        <SelectTrigger aria-labelledby="environment-repo-label" className="w-full">
          <SelectValue placeholder="Select repository" />
        </SelectTrigger>
        <SelectContent align="start" className="max-w-[min(28rem,var(--available-width))]">
          {repos.map((item) => (
            <SelectItem key={repoKey(item)} value={repoKey(item)}>
              {item.fullName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div>
        <div className="flex items-center gap-1.5">
          <label
            className="block text-xs font-medium text-muted-foreground"
            htmlFor="environment-image"
          >
            Environment image (optional)
          </label>
          <InfoTooltip label="Environment image requirements">
            Use a public Docker image from Docker Hub or GHCR. Choose Debian 12/13 or Ubuntu
            22.04/24.04 with the tools your project needs. The app adds its agent runtime and
            handles the checkout. Test environment checks setup only; it does not run an agent
            task.
          </InfoTooltip>
        </div>
        <input
          id="environment-image"
          aria-describedby="environment-image-help"
          value={imageRef}
          onChange={(event) => setImageRef(event.target.value)}
          placeholder="docker.io/acme/my-project-env:latest"
          className="mt-2 h-9 w-full rounded-lg border border-input bg-background px-2.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          spellCheck={false}
        />
        <p id="environment-image-help" className="mt-2 text-xs leading-5 text-muted-foreground">
          New sessions start from this environment in an isolated sandbox. Resumed sessions
          continue from their saved checkpoint. Leave blank to use the default environment.
        </p>
      </div>
      {testResult && (
        <ImageTestResult result={testResult} onClose={() => setTestResult(null)} />
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {configured && <CheckCircle2Icon className="size-3.5 text-emerald-500" />}
          {configured
            ? "Custom environment will be used for new sessions"
            : "Default environment will be used for new sessions"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void test()}
            disabled={busy || testing || !imageRef.trim()}
          >
            {testing ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
            {testing ? "Testing…" : "Test environment"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={busy || testing}
          >
            {busy && <LoaderCircleIcon className="animate-spin" />}
            {busy ? "Saving…" : "Save environment"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ImageTestResult({
  result,
  onClose,
}: {
  result: { ok: boolean; output: string };
  onClose: () => void;
}) {
  return (
    <div
      role={result.ok ? "status" : "alert"}
      className={`rounded-lg border px-3 py-2 text-xs ${
        result.ok
          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
          : "border-destructive/30 bg-destructive/5 text-destructive"
      }`}
    >
      <div className="flex items-center justify-between gap-2 font-medium">
        <div className="flex items-center gap-1.5">
          {result.ok ? (
            <CheckCircle2Icon className="size-3.5" />
          ) : (
            <CircleXIcon className="size-3.5" />
          )}
          {result.ok ? "Environment test passed" : "Environment test failed"}
        </div>
        <button
          type="button"
          aria-label="Close environment test result"
          title="Close environment test result"
          onClick={onClose}
          className="rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
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
