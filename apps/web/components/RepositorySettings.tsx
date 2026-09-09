"use client";

import type {
  RepositoryEnvironmentSummary,
  ReviewRepositoriesResponse,
  ReviewRepository,
  VcsRepository,
} from "@pi-cloud-agent/protocol";
import { LoaderCircleIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { InfoTooltip } from "./LlmConnectionSupport";

export function RepositorySettings() {
  const [data, setData] = useState<ReviewRepositoriesResponse | null>(null);
  const [repos, setRepos] = useState<VcsRepository[]>([]);
  const [images, setImages] = useState<RepositoryEnvironmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, environments, available] = await Promise.all([
        api.listReviewRepositories(),
        api.listRepositoryEnvironments(),
        api.listRepos(),
      ]);
      setData(next);
      setImages(environments);
      setRepos(available);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const rows = [
    ...(data?.repositories.map((review) => ({
      provider: "github",
      repo: review.repo,
      review,
    })) ?? []),
    ...repos
      .filter(
        (repo) =>
          !data?.repositories.some(
            (item) => repo.provider === "github" && item.repo === repo.fullName,
          ),
      )
      .map((repo) => ({ provider: repo.provider, repo: repo.fullName, review: null })),
  ];
  return (
    <section>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-medium tracking-[-0.02em]">Repositories</h2>
          <p className="mt-2 max-w-lg text-xs leading-5 text-muted-foreground">
            Auto-review runs when a non-draft PR is opened or updated. Existing PRs wait for the
            next push. Reviews use your default model. An environment image is the public Docker
            image used to start new sessions for a repository.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.installUrl && (
            <a href={data.installUrl} className="text-xs underline underline-offset-4">
              Manage GitHub access
            </a>
          )}
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCwIcon className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {data?.problem && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {data.problem}
        </p>
      )}
      {loading && !data && (
        <p className="py-8 text-sm text-muted-foreground">Loading repositories…</p>
      )}
      {!loading && !error && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          No repositories connected. Use GitHub access above to install the App, then return
          here.
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem] gap-4 border-b border-border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground sm:grid">
            <span>Repository</span>
            <span className="flex items-center gap-1.5">
              Environment image
              <InfoTooltip label="Environment image requirements">
                Use a public Docker image from Docker Hub or GHCR with the tools your project
                needs. The app adds its agent runtime and manages the checkout inside the
                isolated sandbox.
              </InfoTooltip>
            </span>
            <span className="text-right">Auto-review</span>
          </div>
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <RepositoryRow
                key={`${row.provider}:${row.repo}`}
                {...row}
                image={
                  images.find(
                    (image) => image.provider === row.provider && image.repo === row.repo,
                  )?.imageRef ?? ""
                }
              />
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        Environment changes save when you leave the field and apply to new sessions. Leave blank
        to use the default image.
      </p>
    </section>
  );
}

function RepositoryRow({
  provider,
  repo,
  review,
  image,
}: {
  provider: string;
  repo: string;
  review: ReviewRepository | null;
  image: string;
}) {
  const [enabled, setEnabled] = useState(review?.autoReview ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEnabled(review?.autoReview ?? false);
  }, [review?.autoReview]);
  const toggle = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveReviewRepository({
        installationId: review.installationId,
        repo,
        autoReview: !enabled,
      });
      setEnabled(!enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const problem =
    review?.problem ??
    (provider === "github" && !review
      ? "Install the GitHub App on this repository to enable reviews."
      : null);
  return (
    <li className="grid items-start gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem] sm:gap-4">
      <div className="min-w-0">
        <p className="break-all text-sm font-medium">{repo}</p>
        {problem && <p className="mt-1 text-xs leading-5 text-muted-foreground">{problem}</p>}
        {error && (
          <p role="alert" className="mt-1 break-words text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <EnvironmentEditor provider={provider} repo={repo} image={image} />
      <div className="flex items-center gap-2 sm:justify-end sm:pt-1">
        <span className="text-xs text-muted-foreground sm:hidden">Auto-review</span>
        {provider === "github" ? (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`Auto-review ${repo}`}
            disabled={busy || !review || Boolean(problem && !enabled)}
            onClick={() => void toggle()}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40 ${enabled ? "bg-foreground" : "bg-input"}`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform ${enabled ? "left-0.5 translate-x-4" : "left-0.5"}`}
            />
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
    </li>
  );
}

function EnvironmentEditor({
  provider,
  repo,
  image,
}: {
  provider: string;
  repo: string;
  image: string;
}) {
  const [value, setValue] = useState(image);
  const [saved, setSaved] = useState(image);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setValue(image);
    setSaved(image);
  }, [image]);
  const save = async () => {
    const next = value.trim();
    if (next === saved || busy) return;
    setBusy(true);
    setError(null);
    setMessage("Saving…");
    try {
      await api.saveRepositoryEnvironment({ provider, repo, imageRef: next });
      setSaved(next);
      setValue(next);
      setMessage("Saved");
    } catch (cause) {
      setMessage(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    const imageRef = value.trim();
    if (!imageRef || busy || testing) return;
    setTesting(true);
    setError(null);
    setMessage("Testing…");
    try {
      const result = await api.testRepositoryEnvironment({ provider, repo, imageRef });
      setMessage(result.ok ? "Environment test passed" : null);
      if (!result.ok) setError(result.output || "Environment test failed.");
    } catch (cause) {
      setMessage(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };
  return (
    <div>
      <div className="flex items-start gap-2">
        <input
          aria-label={`Environment image for ${repo}`}
          placeholder="Default image"
          value={value}
          disabled={busy || testing}
          onChange={(event) => {
            setValue(event.target.value);
            setMessage(null);
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          spellCheck={false}
        />
        {value.trim() && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || testing}
            onClick={() => void test()}
            aria-label={`Test environment for ${repo}`}
          >
            {testing ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
            Test
          </Button>
        )}
      </div>
      {message && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 break-words text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
