"use client";

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { api, type LlmOAuthEvent } from "@/lib/api";

const SECURITY_SETTINGS_URL = "https://chatgpt.com/#settings/Security";

function isTrustedVerificationUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname;
    return (
      host === "chatgpt.com" ||
      host.endsWith(".chatgpt.com") ||
      host === "auth.openai.com" ||
      host.endsWith(".openai.com")
    );
  } catch {
    return false;
  }
}

function abortFlow(
  streamAbort: { current: AbortController | null },
  flowId: { current: string | null },
) {
  streamAbort.current?.abort();
  streamAbort.current = null;
  const activeFlowId = flowId.current;
  flowId.current = null;
  if (activeFlowId) void api.cancelLlmOAuth(activeFlowId).catch(() => undefined);
}

type DialogState =
  | { phase: "ready" }
  | { phase: "starting" }
  | { phase: "authorizing"; code: string; verificationUri: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

export function CodexDeviceDialog({
  open,
  onClose,
  onConnected,
  onNotice,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => Promise<void>;
  onNotice: (message: string, kind: "success" | "error") => void;
}) {
  const [state, setState] = useState<DialogState>({ phase: "ready" });
  const [copied, setCopied] = useState(false);
  const flowId = useRef<string | null>(null);
  const streamAbort = useRef<AbortController | null>(null);

  const close = useCallback(() => {
    abortFlow(streamAbort, flowId);
    setState({ phase: "ready" });
    setCopied(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  useEffect(
    () => () => {
      abortFlow(streamAbort, flowId);
    },
    [],
  );

  const handleEvent = async (event: LlmOAuthEvent): Promise<void> => {
    if (event.type === "auth") {
      if (event.event.type !== "device_code") return;
      if (!event.event.userCode || !event.event.verificationUri) {
        setState({ phase: "error", message: "Codex did not return a device code." });
        return;
      }
      if (!isTrustedVerificationUri(event.event.verificationUri)) {
        setState({
          phase: "error",
          message: "Codex returned an unexpected authorization URL.",
        });
        return;
      }
      setState({
        phase: "authorizing",
        code: event.event.userCode,
        verificationUri: event.event.verificationUri,
      });
      return;
    }
    if (event.type === "complete") {
      flowId.current = null;
      await onConnected();
      setState({ phase: "success" });
      onNotice("Codex subscription connected.", "success");
      return;
    }
    flowId.current = null;
    setState({ phase: "error", message: event.message });
    onNotice(event.message, "error");
  };

  const start = async () => {
    abortFlow(streamAbort, flowId);
    setCopied(false);
    setState({ phase: "starting" });
    const abortController = new AbortController();
    streamAbort.current = abortController;
    try {
      const flow = await api.startLlmOAuth();
      if (abortController.signal.aborted) {
        await api.cancelLlmOAuth(flow.flowId).catch(() => undefined);
        return;
      }
      flowId.current = flow.flowId;
      await api.streamLlmOAuth(flow.eventsUrl, handleEvent, abortController.signal);
    } catch (cause) {
      if (abortController.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      flowId.current = null;
      setState({ phase: "error", message });
      onNotice(message, "error");
    } finally {
      if (streamAbort.current === abortController) streamAbort.current = null;
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        aria-label="Close Codex connection dialog"
        className="absolute inset-0 bg-background/70 backdrop-blur-md"
        onClick={close}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-device-title"
        aria-describedby="codex-device-description"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="border-b border-border bg-muted/35 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-background">
                <KeyRoundIcon className="size-5" />
              </div>
              <div>
                <h2 id="codex-device-title" className="text-base font-medium">
                  Connect Codex
                </h2>
                <p id="codex-device-description" className="mt-1 text-sm text-muted-foreground">
                  Authorize this cloud agent with a one-time device code.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-6" aria-live="polite">
          {state.phase === "ready" ? <ReadyStep onStart={() => void start()} /> : null}
          {state.phase === "starting" ? <StartingStep /> : null}
          {state.phase === "authorizing" ? (
            <AuthorizationStep
              code={state.code}
              verificationUri={state.verificationUri}
              copied={copied}
              onCopy={() => void copyCode(state.code)}
            />
          ) : null}
          {state.phase === "success" ? <SuccessStep onDone={close} /> : null}
          {state.phase === "error" ? (
            <ErrorStep message={state.message} onRetry={() => void start()} />
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ReadyStep({ onStart }: { onStart: () => void }) {
  return (
    <div>
      <p className="text-sm leading-6 text-muted-foreground">
        ChatGPT must allow device code authorization for Codex before this agent can connect. In
        a managed workspace, an administrator may need to turn it on.
      </p>

      <ol className="mt-5 space-y-3 text-sm">
        <DialogStep number="1">
          Open ChatGPT Security settings and enable device code authorization.
        </DialogStep>
        <DialogStep number="2">Return here and request a one-time code.</DialogStep>
      </ol>

      <div className="mt-6 grid gap-2">
        <Button
          variant="outline"
          className="w-full"
          nativeButton={false}
          render={<a href={SECURITY_SETTINGS_URL} target="_blank" rel="noreferrer" />}
        >
          Open ChatGPT Security settings
          <ExternalLinkIcon />
        </Button>
        <Button type="button" className="w-full" onClick={onStart} autoFocus>
          I’ve enabled it — get a code
        </Button>
      </div>
    </div>
  );
}

function StartingStep() {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center text-center">
      <LoaderCircleIcon className="size-6 animate-spin text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">Requesting a device code…</p>
      <p className="mt-1 text-xs text-muted-foreground">This usually takes a few seconds.</p>
    </div>
  );
}

function AuthorizationStep({
  code,
  verificationUri,
  copied,
  onCopy,
}: {
  code: string;
  verificationUri: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <ol className="space-y-4 text-sm">
        <DialogStep number="1">
          <p className="font-medium leading-5">Copy this one-time code</p>
          <button
            type="button"
            onClick={onCopy}
            className="mt-2 flex w-full items-center justify-between rounded-xl border border-border bg-muted/45 px-4 py-3 font-mono text-lg font-semibold tracking-[0.18em] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>{code}</span>
            <span className="flex items-center gap-1.5 font-sans text-xs font-normal tracking-normal text-muted-foreground">
              {copied ? (
                <CheckCircle2Icon className="size-4 text-emerald-600" />
              ) : (
                <CopyIcon className="size-4" />
              )}
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
        </DialogStep>
        <DialogStep number="2">
          <p className="font-medium leading-5">Open Codex authorization</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Sign in to ChatGPT if asked, then enter the code above. Keep this dialog open while
            authorization finishes.
          </p>
          <Button
            className="mt-3 w-full"
            nativeButton={false}
            render={<a href={verificationUri} target="_blank" rel="noreferrer" />}
          >
            Continue to ChatGPT
            <ExternalLinkIcon />
          </Button>
        </DialogStep>
      </ol>
      <div className="mt-5 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        Waiting for authorization…
      </div>
    </div>
  );
}

function SuccessStep({ onDone }: { onDone: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2Icon className="size-6" />
      </div>
      <p className="mt-4 font-medium">Codex is connected</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Your available Codex models are now ready for cloud tasks.
      </p>
      <Button type="button" className="mt-6 w-full" onClick={onDone} autoFocus>
        Done
      </Button>
    </div>
  );
}

function ErrorStep({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div>
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
        <div className="flex gap-3">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="text-sm font-medium">Couldn’t connect Codex</p>
            <p role="alert" className="mt-1 text-xs leading-5 text-muted-foreground">
              {message}
            </p>
            <a
              href={SECURITY_SETTINGS_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-foreground"
            >
              Check device code authorization
              <ExternalLinkIcon className="size-3.5" />
            </a>
          </div>
        </div>
      </div>
      <Button type="button" className="mt-6 w-full" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function DialogStep({ number, children }: { number: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-border font-mono text-[10px] text-muted-foreground">
        {number}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}
