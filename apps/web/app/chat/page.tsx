"use client";

import type {
  ConfigResponse,
  LlmConnectionSummary,
  VcsRepository,
} from "@pi-cloud-agent/protocol";
import { FolderGit2Icon, GitBranchIcon, SlidersHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ChatComposer } from "@/components/ChatComposer";
import { ModelSelect } from "@/components/ModelSelect";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { defaultModelSelection, parseModelSelection } from "@/lib/model-selection";
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
  const [repos, setRepos] = useState<VcsRepository[]>([]);
  const [modelConnections, setModelConnections] = useState<LlmConnectionSummary[]>([]);
  const [repo, setRepo] = useState(params.get("repo") ?? "");
  const [provider, setProvider] = useState("github");
  const [profile, setProfile] = useState(params.get("profile") ?? "");
  const [modelSelection, setModelSelection] = useState("");
  const [prompt, setPrompt] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getConfig(), api.listRepos(), api.listLlmConnections()])
      .then(([loadedConfig, loadedRepos, loadedConnections]) => {
        if (!alive) return;
        setConfig(loadedConfig);
        setRepos(loadedRepos);
        setModelConnections(loadedConnections);
        setModelSelection(defaultModelSelection(loadedConnections));
        setProfile((current) => current || loadedConfig.defaultProfile);
        const selected = loadedRepos[0];
        if (selected) {
          setRepo((current) => current || selected.fullName);
          setProvider(selected.provider);
        }
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!repo || !provider) {
      setBranches([]);
      setBranch("");
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    api
      .listBranches(provider, repo)
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
  }, [provider, repo]);

  const canSubmit =
    Boolean(repo) &&
    Boolean(profile) &&
    Boolean(prompt.trim()) &&
    !submitting &&
    Boolean(modelSelection);
  const activeProfile = config?.profiles.find((entry) => entry.name === profile);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const selection = parseModelSelection(modelSelection);
      if (!selection) throw new Error("choose a model before starting a task");
      const session = await api.createSession({
        repo,
        provider,
        profile,
        prompt: prompt.trim(),
        branch: branch || null,
        modelConnectionId: selection.connectionId,
        modelId: selection.modelId,
      });
      saveSessionTitle(session.id, prompt.trim());
      router.push(`/sessions/${session.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="app-header flex h-12 shrink-0 items-center px-4">
        <h1 className="text-[13px] font-medium">New task</h1>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-10 sm:px-8">
        <div className="w-full max-w-2xl">
          <div className="mb-6 text-center">
            <h2 className="text-xl font-medium tracking-[-0.02em]">What are you up to?</h2>
          </div>
          <ChatComposer
            value={prompt}
            onChange={setPrompt}
            onSubmit={submit}
            placeholder="Describe the task for Pi…"
            submitLabel="Start"
            submitEnabled={canSubmit}
            submitting={submitting}
            disabled={!repo}
            autoFocus
            tools={
              <ComposerOptions
                repo={repo}
                repos={repos}
                onRepoChange={(selected) => {
                  setRepo(selected.fullName);
                  setProvider(selected.provider);
                }}
                onManualRepoChange={(value) => {
                  setRepo(value);
                  setProvider("github");
                }}
                profile={profile}
                profiles={config?.profiles.map((entry) => entry.name) ?? []}
                onProfileChange={setProfile}
                modelSelection={modelSelection}
                modelConnections={modelConnections}
                onModelSelectionChange={setModelSelection}
                branch={branch}
                branches={branches}
                branchesLoading={branchesLoading}
                onBranchChange={setBranch}
              />
            }
          />
          <p className="mt-3 px-2 text-center text-xs text-muted-foreground">
            {modelConnections.length === 0 ? (
              <>
                Add a model connection in{" "}
                <Link href="/settings" className="underline underline-offset-2">
                  Settings
                </Link>{" "}
                before starting a task.
              </>
            ) : repos.length === 0 ? (
              <>
                Connect a VCS identity in{" "}
                <Link href="/settings" className="underline underline-offset-2">
                  Settings
                </Link>{" "}
                to choose a repository.
              </>
            ) : (
              (activeProfile?.description ??
              "Profiles and repositories load from the controller.")
            )}
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
  repos: VcsRepository[];
  onRepoChange: (value: VcsRepository) => void;
  onManualRepoChange: (value: string) => void;
  profile: string;
  profiles: string[];
  onProfileChange: (value: string) => void;
  modelSelection: string;
  modelConnections: LlmConnectionSummary[];
  onModelSelectionChange: (value: string) => void;
  branch: string;
  branches: string[];
  branchesLoading: boolean;
  onBranchChange: (value: string) => void;
};

function ComposerOptions(props: ComposerOptionsProps) {
  const triggerClass =
    "h-7 min-w-0 max-w-36 shrink border-0 bg-transparent px-1.5 text-xs shadow-none dark:bg-transparent";
  return (
    <>
      <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {props.repos.length === 0 ? (
        <input
          aria-label="Repository"
          className="h-7 w-32 min-w-0 border-0 bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground"
          placeholder="owner/repo"
          value={props.repo}
          onChange={(event) => props.onManualRepoChange(event.target.value)}
        />
      ) : (
        <Select
          value={props.repo}
          onValueChange={(value) => {
            const selected = props.repos.find((entry) => entry.fullName === value);
            if (selected) props.onRepoChange(selected);
          }}
        >
          <SelectTrigger aria-label="Repository" className={triggerClass}>
            <SelectValue placeholder="Repository" />
          </SelectTrigger>
          <SelectContent align="start">
            {props.repos.map((entry) => (
              <SelectItem key={`${entry.provider}:${entry.fullName}`} value={entry.fullName}>
                {entry.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
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
      <ModelSelect
        connections={props.modelConnections}
        value={props.modelSelection}
        onChange={props.onModelSelectionChange}
        className={triggerClass}
      />
    </>
  );
}
