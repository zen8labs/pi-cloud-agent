import type { RunStatus } from "@pi-cloud-agent/protocol";
import { isActiveStatus, STATUS_LABELS } from "@/lib/format";

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className="inline-flex w-fit items-center gap-1.5 text-xs font-medium"
      style={{ color: `var(--status-${status})` }}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${isActiveStatus(status) ? "animate-pulse-dot" : ""}`}
        style={{ background: `var(--status-${status})` }}
      />
      {STATUS_LABELS[status]}
    </span>
  );
}
