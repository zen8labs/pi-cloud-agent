"use client";

import type { LlmConnectionSummary, VcsConnectionSummary } from "@pi-cloud-agent/protocol";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { LlmConnectionSection } from "@/components/LlmConnectionSection";
import { AzureDevOpsMarkIcon, GithubMarkIcon } from "@/components/ProviderIcons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { api } from "@/lib/api";

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const searchParams = useSearchParams();
  const [connections, setConnections] = useState<VcsConnectionSummary[]>([]);
  const [llmConnections, setLlmConnections] = useState<LlmConnectionSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    message: string;
    kind: "success" | "error";
  } | null>(null);
  const result = searchParams.get("connection");
  const callbackMessage = searchParams.get("message");
  const callbackNotice = result
    ? result === "connected"
      ? "Connection saved."
      : callbackMessage || `Connection ${result.replaceAll("_", " ")}.`
    : null;
  const noticeMessage = error ?? actionNotice?.message ?? callbackNotice;
  const noticeKind = error
    ? "error"
    : (actionNotice?.kind ?? (result === "connected" ? "success" : "error"));
  const [dismissedNotice, setDismissedNotice] = useState(false);

  const notify = (message: string, kind: "success" | "error") => {
    setError(null);
    setActionNotice({ message, kind });
    setDismissedNotice(false);
  };

  useEffect(() => {
    void Promise.all([api.listConnections(), api.listLlmConnections()])
      .then(([vcs, llm]) => {
        setConnections(vcs);
        setLlmConnections(llm);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    setDismissedNotice(false);
    // Errors persist until dismissed; only successes auto-dismiss.
    if (!noticeMessage || noticeKind !== "success") return;
    const timer = window.setTimeout(() => setDismissedNotice(true), 7000);
    return () => window.clearTimeout(timer);
  }, [noticeMessage, noticeKind]);

  const disconnect = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      await api.deleteConnection(provider);
      setConnections(await api.listConnections());
      notify("Connection disconnected.", "success");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setBusy(null);
    }
  };

  const refreshLlm = async () => setLlmConnections(await api.listLlmConnections());

  return (
    <div data-testid="settings-scroll" className="h-full overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 flex h-12 items-center border-b border-border bg-background px-5">
        <h1 className="text-[13px] font-medium">Settings</h1>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
        <div className="mb-8">
          <h2 className="text-xl font-medium tracking-[-0.02em]">Git Connections</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Repository access for your tasks.
          </p>
        </div>

        <div className="space-y-3">
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.provider}
              connection={connection}
              busy={busy === connection.provider}
              onDisconnect={() => disconnect(connection.provider)}
            />
          ))}
        </div>

        <div className="mb-8 mt-12">
          <h2 className="text-xl font-medium tracking-[-0.02em]">Models</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Choose your default model and manage provider connections.
          </p>
        </div>

        <LlmConnectionSection
          connections={llmConnections}
          onChanged={refreshLlm}
          onNotice={notify}
        />
      </main>
      {noticeMessage && !dismissedNotice && (
        <ConnectionNotice
          message={noticeMessage}
          kind={noticeKind}
          onClose={() => setDismissedNotice(true)}
        />
      )}
    </div>
  );
}

function ConnectionNotice({
  message,
  kind,
  onClose,
}: {
  message: string;
  kind: "success" | "error";
  onClose: () => void;
}) {
  const success = kind === "success";
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 w-[min(24rem,calc(100vw-2rem))]">
      <div
        role={success ? "status" : "alert"}
        className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg shadow-black/10 ${
          success
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
        }`}
      >
        <AlertCircleIcon className={`mt-0.5 size-4 shrink-0 ${success ? "hidden" : ""}`} />
        {success && <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />}
        <p className="min-w-0 flex-1 break-words">{message}</p>
        <button
          type="button"
          aria-label="Close notification"
          onClick={onClose}
          className="shrink-0 rounded-md p-0.5 opacity-70 transition-opacity hover:opacity-100"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function ConnectionCard({
  connection,
  busy,
  onDisconnect,
}: {
  connection: VcsConnectionSummary;
  busy: boolean;
  onDisconnect: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const isGithub = connection.provider === "github";
  return (
    <section className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-4">
      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
        {isGithub ? (
          <GithubMarkIcon className="size-5" />
        ) : (
          <AzureDevOpsMarkIcon className="size-5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{connection.displayName}</h3>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              connection.connected ? "bg-emerald-500" : "bg-muted-foreground/40"
            }`}
          />
          <span className="truncate">
            {connection.connected
              ? `Connected${connection.accountName ? ` as ${connection.accountName}` : ""}`
              : connection.configured
                ? "Not connected"
                : "OAuth client not configured"}
          </span>
        </p>
      </div>
      {connection.connected ? (
        <Button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy}
          variant="destructive"
          size="sm"
        >
          <UnplugIcon className="size-3.5" />
          Disconnect
        </Button>
      ) : (
        <a
          href={connection.configured ? api.connectUrl(connection.provider) : undefined}
          aria-disabled={!connection.configured}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90 aria-disabled:pointer-events-none aria-disabled:opacity-40"
        >
          <ExternalLinkIcon className="size-3.5" />
          Connect
        </a>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Disconnect ${connection.displayName}?`}
        description="Tasks will lose repository access through this identity until you connect again."
        confirmLabel="Disconnect"
        busyLabel="Disconnecting…"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void onDisconnect().finally(() => setConfirming(false))}
      />
    </section>
  );
}
