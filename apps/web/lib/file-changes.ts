/**
 * Pure write/edit diff accounting. Shared by the activity feed and the
 * environment panel so +/− totals cannot drift between surfaces.
 */

export type FileChangeStat = {
  path: string;
  added: number;
  removed: number;
};

type DiffKind = "add" | "del";

export type DiffLine = {
  key: string;
  kind: DiffKind;
  text: string;
  lineNo: number;
};

export type FileDiff = {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  copyText: string;
};

type EditHunk = { oldText: string; newText: string };

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toolPath(args: Record<string, unknown>): string {
  return asString(args.path) ?? asString(args.filePath) ?? asString(args.file_path) ?? "file";
}

function splitLines(text: string): string[] {
  if (!text) return [""];
  const parts = text.split("\n");
  // A trailing newline is a terminator, not an empty final line.
  if (parts.length > 1 && parts.at(-1) === "") parts.pop();
  return parts;
}

function linesFromText(text: string, kind: DiffKind, keyPrefix: string): DiffLine[] {
  return splitLines(text).map((line, index) => {
    const lineNo = index + 1;
    return {
      key: `${keyPrefix}-${kind}-${lineNo}`,
      kind,
      text: line,
      lineNo,
    };
  });
}

function parseEditHunks(args: Record<string, unknown>): EditHunk[] {
  const raw = args.edits;
  const hunks: EditHunk[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const oldText = asString(record.oldText);
      const newText = asString(record.newText);
      if (oldText === null || newText === null) continue;
      hunks.push({ oldText, newText });
    }
  }
  const legacyOld = asString(args.oldText);
  const legacyNew = asString(args.newText);
  if (legacyOld !== null && legacyNew !== null) {
    hunks.push({ oldText: legacyOld, newText: legacyNew });
  }
  return hunks;
}

function buildWriteDiff(args: Record<string, unknown>): FileDiff | null {
  const content = asString(args.content);
  if (content === null) return null;
  const lines = linesFromText(content, "add", "write");
  return {
    path: toolPath(args),
    lines,
    added: lines.length,
    removed: 0,
    copyText: content,
  };
}

function buildEditDiff(args: Record<string, unknown>): FileDiff | null {
  const hunks = parseEditHunks(args);
  if (!hunks.length) return null;
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  const copyParts: string[] = [];
  for (const [hunkIndex, hunk] of hunks.entries()) {
    const prefix = `edit-${hunkIndex}`;
    const del = linesFromText(hunk.oldText, "del", prefix);
    const add = linesFromText(hunk.newText, "add", prefix);
    lines.push(...del, ...add);
    removed += del.length;
    added += add.length;
    copyParts.push(hunk.newText);
  }
  return {
    path: toolPath(args),
    lines,
    added,
    removed,
    copyText: copyParts.join("\n"),
  };
}

export function buildFileDiff(tool: string, args: Record<string, unknown>): FileDiff | null {
  switch (tool.toLowerCase()) {
    case "write":
      return buildWriteDiff(args);
    case "edit":
      return buildEditDiff(args);
    default:
      return null;
  }
}

/** Line-level +/− for one write/edit tool call; null when the args are not a file change. */
export function fileChangeStats(
  tool: string,
  args: Record<string, unknown>,
): FileChangeStat | null {
  const diff = buildFileDiff(tool, args);
  if (!diff) return null;
  return { path: diff.path, added: diff.added, removed: diff.removed };
}
