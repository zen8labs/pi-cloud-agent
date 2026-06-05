import { STATUS_META, ACTIVE_STATUSES } from "@/lib/format";
import type { RunStatus } from "@/lib/types";

export function StatusBadge({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.queued;
  const active = ACTIVE_STATUSES.includes(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${meta.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${active ? "animate-pulse-dot" : ""}`} />
      {meta.label}
    </span>
  );
}
