import { ACTIVE_STATUSES } from "@/lib/format";
import type { RunStatus } from "@/lib/types";

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  provisioning: "Provisioning",
  running: "Running",
  publishing: "Publishing",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const active = ACTIVE_STATUSES.includes(status);
  const k = status;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider"
      style={{
        color: `var(--status-${k}-fg)`,
        background: `var(--status-${k}-bg)`,
        border: `1px solid var(--status-${k}-border)`,
      }}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "animate-pulse-dot" : ""}`}
        style={{ background: `var(--status-${k}-dot)` }}
      />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
