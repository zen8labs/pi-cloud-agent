"use client";

import type { ConfigResponse } from "@pi-cloud-agent/protocol";
import { FolderGit2Icon, GitBranchIcon, SlidersHorizontalIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ChatComposer } from "@/components/ChatComposer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { saveSessionTitle } from "@/lib/session-titles";

export default function ChatPage() {
  return (
    <Suspense>
      <NewSession />
    </Suspense>
  );
}

function NewSession() {
  const router = useRouter();
  const params = useSearchParams();
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState(params.get("repo") ?? "");
  const [customRepo, setCustomRepo] = useState("");
  const [profile, setProfile] = useState(params.get("profile") ?? "");
  const [prNumber, setPrNumber] = useState("");
  const [prompt, setPrompt] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getConfig(), api.listRepos()])
      .then(([loadedConfig, loadedRepos]) => {
        if (!alive) return;
        setConfig(loadedConfig);
        setRepos(loadedRepos);
        setProfile((current) => current || loadedConfig.defaultProfile);
        setRepo((current) => current || loadedRepos[0] || "__custom__");
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  const effectiveRepo = repo === "__custom__" ? customRepo.trim() : repo;

  useEffect(() => {
    if (!effectiveRepo.includes("/")) {
      setBranches([]);
      setBranch("");
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    api
      .listBranches(effectiveRepo)
      .then((result) => {
        if (!cancelled) {
          setBranches(result.branches);
          setBranch(result.default ?? result.branches[0] ?? "");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBranches([]);
          setBranch("");
        }
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveRepo]);

  const needsPullRequest = profile === "pr-review";
  const canSubmit =
    Boolean(effectiveRepo) &&
    Boolean(profile) &&
    (needsPullRequest ? Boolean(prNumber.trim()) : Boolean(prompt.trim())) &&
    !submitting;
  const activeProfile = config?.profiles.find((entry) => entry.name === profile);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await api.createRun({
        repo: effectiveRepo,
        profile,
        prompt: prompt.trim() || "Review this pull request.",
        branch: branch || null,
        prNumber: needsPullRequest ? Number(prNumber) : null,
      });
      saveSessionTitle(run.id, prompt.trim() || `Review ${effectiveRepo}`);
      router.push(`/sessions/${run.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-5">
        <h1 className="text-sm font-medium">New task</h1>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-10 sm:px-8">
        <div className="w-full max-w-3xl">
          <div className="mb-7 text-center">
            <h2 className="text-2xl font-medium tracking-[-0.035em]">
              What should Pi work on?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Start a sandboxed session in one of your repositories.
            </p>
          </div>
          {repo === "__custom__" && (
            <input
              aria-label="Repository path"
              value={customRepo}
              onChange={(event) => setCustomRepo(event.target.value)}
              placeholder="owner/repo"
              className="mb-2 h-9 w-full rounded-xl border border-input bg-background px-3 font-mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
            />
          )}
          <ChatComposer
            value={prompt}
            onChange={setPrompt}
            onSubmit={submit}
            placeholder={
              needsPullRequest ? "Add an optional reviewer note…" : "Describe the task for Pi…"
            }
            model={config?.model}
            submitLabel="Start"
            submitEnabled={canSubmit}
            submitting={submitting}
            disabled={!effectiveRepo}
            autoFocus
            tools={
              <ComposerOptions
                repo={repo}
                repos={repos}
                onRepoChange={setRepo}
                profile={profile}
                profiles={config?.profiles.map((entry) => entry.name) ?? []}
                onProfileChange={setProfile}
                branch={branch}
                branches={branches}
                branchesLoading={branchesLoading}
                onBranchChange={setBranch}
                needsPullRequest={needsPullRequest}
                prNumber={prNumber}
                onPrNumberChange={setPrNumber}
              />
            }
          />
          <p className="mt-3 px-2 text-center text-xs text-muted-foreground">
            {activeProfile?.description ??
              "Profiles and repositories load from the controller."}
          </p>
          {error && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type ComposerOptionsProps = {
  repo: string;
  repos: string[];
  onRepoChange: (value: string) => void;
  profile: string;
  profiles: string[];
  onProfileChange: (value: string) => void;
  branch: string;
  branches: string[];
  branchesLoading: boolean;
  onBranchChange: (value: string) => void;
  needsPullRequest: boolean;
  prNumber: string;
  onPrNumberChange: (value: string) => void;
};

function ComposerOptions(props: ComposerOptionsProps) {
  const triggerClass =
    "h-7 max-w-44 border-0 bg-transparent px-1.5 text-xs shadow-none dark:bg-transparent";
  return (
    <>
      <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <Select value={props.repo} onValueChange={(value) => props.onRepoChange(value ?? "")}>
        <SelectTrigger aria-label="Repository" className={triggerClass}>
          <SelectValue placeholder="Repository" />
        </SelectTrigger>
        <SelectContent align="start">
          {props.repos.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
          <SelectItem value="__custom__">Custom repository…</SelectItem>
        </SelectContent>
      </Select>
      <SlidersHorizontalIcon className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
      <Select
        value={props.profile}
        onValueChange={(value) => props.onProfileChange(value ?? "")}
      >
        <SelectTrigger aria-label="Profile" className={triggerClass}>
          <SelectValue placeholder="Profile" />
        </SelectTrigger>
        <SelectContent>
          {props.profiles.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {props.needsPullRequest ? (
        <input
          aria-label="Pull request"
          value={props.prNumber}
          onChange={(event) => props.onPrNumberChange(event.target.value.replace(/\D/g, ""))}
          placeholder="PR #"
          inputMode="numeric"
          className="h-7 w-16 rounded-md bg-transparent px-1.5 font-mono text-xs outline-none"
        />
      ) : (
        <>
          <GitBranchIcon className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
          <Select
            value={props.branch}
            onValueChange={(value) => props.onBranchChange(value ?? "")}
            disabled={props.branchesLoading || props.branches.length === 0}
          >
            <SelectTrigger aria-label="Branch" className={triggerClass}>
              <SelectValue placeholder={props.branchesLoading ? "Loading…" : "Branch"} />
            </SelectTrigger>
            <SelectContent>
              {props.branches.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
    </>
  );
}
