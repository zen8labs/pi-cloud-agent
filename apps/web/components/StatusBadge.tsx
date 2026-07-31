import type { RunStatus } from "@pi-cloud-agent/protocol";
import { isActiveStatus, STATUS_LABELS } from "@/lib/format";

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className="inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-wide"
      style={{
        color: `var(--status-${status}-fg)`,
        background: `var(--status-${status}-bg)`,
        border: `1px solid var(--status-${status}-border)`,
      }}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActiveStatus(status) ? "animate-pulse-dot" : ""}`}
        style={{ background: `var(--status-${status}-dot)` }}
      />
      {STATUS_LABELS[status]}
    </span>
  );
}
