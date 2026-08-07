"use client";

import type { RunEvent } from "@pi-cloud-agent/protocol";
import type { CodeViewItem } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionTurn } from "@/lib/useSession";

type TurnDiff = {
  turnNumber: number;
  runId: string;
  patch: string;
  files: number;
  added: number;
  removed: number;
  truncated: boolean;
};

type DiffItem = CodeViewItem;

const MemoizedCodeView = memo(CodeView) as typeof CodeView;

export function SessionDiffSidebar({
  turns,
  open,
  target,
  onClose,
}: {
  turns: SessionTurn[];
  open: boolean;
  target: { path: string; request: number } | null;
  onClose: () => void;
}) {
  const diffs = useMemo(() => collectTurnDiffs(turns), [turns]);
  const latestDiff = diffs.at(-1);
  const stableLatestDiff = useStableTurnDiff(latestDiff);
  const items = useMemo(
    () => (open && stableLatestDiff ? parseDiffItems(stableLatestDiff) : []),
    [open, stableLatestDiff],
  );
  const [dark, setDark] = useState(false);
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const autoScrolledRequest = useRef<number | null>(null);
  const targetPath = target?.path;
  const targetRequest = target?.request;
  const codeViewOptions = useMemo(
    () => ({
      diffStyle: "unified" as const,
      diffIndicators: "bars" as const,
      hunkSeparators: "line-info" as const,
      theme: dark ? "pierre-dark" : "pierre-light",
      themeType: dark ? ("dark" as const) : ("light" as const),
      overflow: "scroll" as const,
      lineDiffType: "word-alt" as const,
      unsafeCSS:
        ":host { --diffs-bg: var(--background) !important; --diffs-dark-bg: var(--background) !important; --diffs-light-bg: var(--background) !important; --diffs-dark: var(--foreground) !important; --diffs-light: var(--foreground) !important; background-color: var(--background) !important; color: var(--foreground) !important; }",
    }),
    [dark],
  );
  const renderHeaderMetadata = useCallback((item: CodeViewItem) => {
    const turn = item.id.split(":", 1)[0]?.replace("turn-", "");
    return <span className="text-[10px] opacity-60">turn {turn}</span>;
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (
      !open ||
      targetPath === undefined ||
      targetRequest === undefined ||
      !items.length ||
      autoScrolledRequest.current === targetRequest
    )
      return;
    const normalizedTargetPath = normalizePath(targetPath);
    const item = items.find((candidate) => {
      if (candidate.type !== "diff") return false;
      const file = candidate.fileDiff;
      return [file.name, file.prevName].some(
        (name) => name && normalizePath(name) === normalizedTargetPath,
      );
    });
    if (!item) return;
    const frame = requestAnimationFrame(() => {
      const codeView = codeViewRef.current;
      if (!codeView || autoScrolledRequest.current === targetRequest) return;
      autoScrolledRequest.current = targetRequest;
      codeView.scrollTo({
        type: "item",
        id: item.id,
        align: "start",
        behavior: "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [items, open, targetPath, targetRequest]);

  const stats = latestDiff ?? { files: 0, added: 0, removed: 0 };
  const hasActiveTurn = turns.at(-1)?.run.status === "running";

  return (
    <aside
      aria-label="Session code changes"
      className="flex h-full min-h-0 w-full flex-col border-l border-border bg-background text-foreground"
    >
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">Changes</h2>
            {hasActiveTurn ? (
              <span className="animate-pulse-dot rounded-full bg-blue-500 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-white">
                Live
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {items.length ? (
              <>
                {stats.files} {stats.files === 1 ? "file" : "files"} ·{" "}
                <span className="text-emerald-600 dark:text-emerald-400">+{stats.added}</span>{" "}
                <span className="text-red-600 dark:text-red-400">-{stats.removed}</span>
              </>
            ) : hasActiveTurn ? (
              "Collecting the turn's final workspace diff…"
            ) : (
              "No code changes in this session"
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close changes"
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </header>
      {latestDiff?.truncated ? (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          Large changes are bounded for responsiveness. The displayed patch is a prefix of the
          full diff.
        </div>
      ) : null}
      {items.length ? (
        <div className="session-diff-view min-h-0 flex-1 overflow-hidden bg-background">
          <MemoizedCodeView
            items={items}
            options={codeViewOptions}
            className="h-full min-h-full w-full overflow-auto overscroll-contain"
            ref={codeViewRef}
            renderHeaderMetadata={renderHeaderMetadata}
          />
        </div>
      ) : (
        <EmptyDiffState active={hasActiveTurn} />
      )}
    </aside>
  );
}

function EmptyDiffState({ active }: { active: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
      <div className="mb-3 grid size-10 place-items-center rounded-xl border border-dashed border-border bg-muted/30 text-muted-foreground">
        <span className="font-mono text-sm">+−</span>
      </div>
      <p className="text-sm font-medium text-foreground/80">
        {active ? "Changes will appear here" : "Nothing changed"}
      </p>
      <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
        {active
          ? "The sidebar updates when the agent finishes this turn."
          : "This session did not leave a Git-tracked change."}
      </p>
    </div>
  );
}

function collectTurnDiffs(turns: SessionTurn[]): TurnDiff[] {
  return turns.flatMap((turn) => {
    const event = [...turn.events]
      .reverse()
      .find((candidate) => candidate.type === "log" && candidate.data.event === "git.diff");
    if (!event) return [];
    return [diffFromEvent(turn, event)];
  });
}

function useStableTurnDiff(diff: TurnDiff | undefined): TurnDiff | undefined {
  const stable = useRef<TurnDiff | undefined>(undefined);
  const previous = stable.current;
  if (
    previous?.runId !== diff?.runId ||
    previous?.turnNumber !== diff?.turnNumber ||
    previous?.patch !== diff?.patch
  ) {
    stable.current = diff;
  }
  return stable.current;
}

function diffFromEvent(turn: SessionTurn, event: RunEvent): TurnDiff {
  return {
    turnNumber: turn.run.turnNumber ?? 1,
    runId: turn.run.id,
    patch: stringValue(event.data.patch),
    files: numberValue(event.data.files),
    added: numberValue(event.data.added),
    removed: numberValue(event.data.removed),
    truncated: event.data.truncated === true,
  };
}

function parseDiffItems(diff: TurnDiff): DiffItem[] {
  if (!diff.patch) return [];
  try {
    return parsePatchFiles(diff.patch, `turn-${diff.turnNumber}-${diff.runId}`, false).flatMap(
      (parsed) =>
        parsed.files.map((fileDiff, index) => ({
          id: `turn-${diff.turnNumber}:${diff.runId}:${index}:${fileDiff.name}`,
          type: "diff" as const,
          fileDiff,
        })),
    );
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizePath(path: unknown): string {
  if (typeof path === "string") return path.replace(/^([ab]\/)/, "");
  if (path && typeof path === "object" && "path" in path) {
    return normalizePath(path.path);
  }
  return "";
}
