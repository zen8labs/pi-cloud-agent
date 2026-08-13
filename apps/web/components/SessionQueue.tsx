"use client";

import type { RunDetail } from "@pi-cloud-agent/protocol";
import { ArrowUpIcon, ChevronDownIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";

export function SessionQueue({
  runs,
  activeRunId,
  onChanged,
}: {
  runs: RunDetail[];
  activeRunId: string | null;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (runs.length === 0) return null;

  const act = async (runId: string, interrupt: boolean) => {
    setBusyId(runId);
    setError(null);
    try {
      if (interrupt && activeRunId) await api.cancelRun(activeRunId);
      else await api.cancelRun(runId);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-background shadow-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent/50"
      >
        <ChevronDownIcon
          className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span>{runs.length} queued</span>
      </button>
      {open ? (
        <div className="border-t border-border">
          <ol className="max-h-40 overflow-y-auto px-2 py-1.5">
            {runs.map((run, index) => (
              <li
                key={run.id}
                className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                <span className="size-2 shrink-0 rounded-full border border-muted-foreground/50" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {run.prompt}
                </span>
                <button
                  type="button"
                  aria-label="Remove queued message"
                  title="Remove from queue"
                  disabled={busyId !== null}
                  onClick={() => void act(run.id, false)}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-70 hover:bg-background hover:text-foreground disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
                {index === 0 && activeRunId ? (
                  <button
                    type="button"
                    aria-label="Interrupt current turn and send this message"
                    title="Interrupt and send next"
                    disabled={busyId !== null}
                    onClick={() => void act(run.id, true)}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-70 hover:bg-background hover:text-foreground disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {error ? (
            <p
              role="alert"
              className="border-t border-border px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
