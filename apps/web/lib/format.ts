import { ACTIVE_STATUSES, type RunStatus } from "@pi-cloud-agent/protocol";

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  provisioning: "Provisioning",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function isActiveStatus(status: RunStatus): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}
