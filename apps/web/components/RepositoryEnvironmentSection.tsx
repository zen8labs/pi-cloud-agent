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
          <h3 className="text-sm font-medium">Repository container image</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Choose the starting environment for new sessions in this repository. Each new
            session starts an isolated sandbox from this image.
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
          ? "Repository image saved."
          : "Repository image cleared; bundled image will be used.",
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
          htmlFor="environment-image"
        >
          Container image (optional)
        </label>
        <input
          id="environment-image"
          value={imageRef}
          onChange={(event) => setImageRef(event.target.value)}
          placeholder="docker.io/acme/my-agent-env:latest"
          className="mt-2 h-9 w-full rounded-lg border border-input bg-background px-2.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          spellCheck={false}
        />
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Enter a public Docker or OCI image that already contains the language runtimes and
          tools your project needs. It must be able to run the app and provide a writable
          workspace with Node.js, git, and GitHub CLI. Use <strong>Test image</strong> to check
          it before saving. Each new session for this repository starts an isolated sandbox from
          this image. Leave blank to use the default environment.
        </p>
      </div>
      {testResult && <ImageTestResult result={testResult} />}
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {configured && <CheckCircle2Icon className="size-3.5 text-emerald-500" />}
          {configured
            ? "Custom image will be used for new sessions"
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
            {testing ? "Testing…" : "Test image"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={busy || testing}
          >
            {busy && <LoaderCircleIcon className="animate-spin" />}
            {busy ? "Saving…" : "Save container image"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ImageTestResult({ result }: { result: { ok: boolean; output: string } }) {
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
        {result.ok ? "Image test passed" : "Image test failed"}
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
