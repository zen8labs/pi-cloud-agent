"use client";

import type { VcsConnectionSummary } from "@pi-cloud-agent/protocol";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  GitBranchIcon,
  PlugIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const result = searchParams.get("connection");
  const callbackMessage = searchParams.get("message");
  const noticeMessage = error
    ? error
    : result === "connected"
      ? "Connection saved."
      : result
        ? callbackMessage || `Connection ${result.replaceAll("_", " ")}.`
        : null;
  const noticeKind = error || result !== "connected" ? "error" : "success";
  const [dismissedNotice, setDismissedNotice] = useState(false);

  useEffect(() => {
    void api
      .listConnections()
      .then(setConnections)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    setDismissedNotice(false);
    if (!noticeMessage) return;
    const timer = window.setTimeout(() => setDismissedNotice(true), 7000);
    return () => window.clearTimeout(timer);
  }, [noticeMessage]);

  const disconnect = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      await api.deleteConnection(provider);
      setConnections(await api.listConnections());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-full bg-background">
      <header className="flex h-12 items-center border-b border-border px-5">
        <h1 className="text-[13px] font-medium">Settings</h1>
      </header>
      <main className="mx-auto max-w-2xl px-5 py-10 sm:px-8">
        <div className="mb-8">
          <h2 className="text-xl font-medium tracking-[-0.02em]">Connected identities</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Connect the accounts Pi should use when listing and accessing repositories.
          </p>
        </div>

        <div className="space-y-3">
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.provider}
              connection={connection}
              busy={busy === connection.provider}
              onDisconnect={() => void disconnect(connection.provider)}
            />
          ))}
        </div>
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
  onDisconnect: () => void;
}) {
  const isGithub = connection.provider === "github";
  return (
    <section className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-4">
      <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
        {isGithub ? <GitBranchIcon className="size-5" /> : <PlugIcon className="size-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{connection.displayName}</h3>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {connection.connected
            ? connection.accountName || "Connected"
            : connection.configured
              ? "Not connected"
              : "OAuth client not configured"}
        </p>
      </div>
      {connection.connected ? (
        <button
          type="button"
          onClick={onDisconnect}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <UnplugIcon className="size-3.5" />
          Disconnect
        </button>
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
    </section>
  );
}
