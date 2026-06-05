import type { RunStatus } from "./types";

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const STATUS_META: Record<RunStatus, { label: string; dot: string; chip: string }> = {
  queued: { label: "Queued", dot: "bg-amber-400", chip: "bg-amber-50 text-amber-700" },
  provisioning: {
    label: "Provisioning",
    dot: "bg-sky-400",
    chip: "bg-sky-50 text-sky-700",
  },
  running: { label: "Running", dot: "bg-blue-500", chip: "bg-blue-50 text-blue-700" },
  publishing: {
    label: "Publishing",
    dot: "bg-violet-500",
    chip: "bg-violet-50 text-violet-700",
  },
  succeeded: {
    label: "Succeeded",
    dot: "bg-emerald-500",
    chip: "bg-emerald-50 text-emerald-700",
  },
  failed: { label: "Failed", dot: "bg-red-500", chip: "bg-red-50 text-red-700" },
  cancelled: { label: "Cancelled", dot: "bg-stone-400", chip: "bg-stone-100 text-stone-600" },
};

export const ACTIVE_STATUSES: RunStatus[] = [
  "queued",
  "provisioning",
  "running",
  "publishing",
];
