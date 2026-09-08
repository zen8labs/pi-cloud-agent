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

export function formatDuration(seconds: number): string {
  const units = [
    { threshold: 86_400, divisor: 86_400, label: "day" },
    { threshold: 3_600, divisor: 3_600, label: "hour" },
    { threshold: 60, divisor: 60, label: "minute" },
    { threshold: 0, divisor: 1, label: "second" },
  ];
  const unit = units.find((candidate) => seconds >= candidate.threshold) ?? {
    threshold: 0,
    divisor: 1,
    label: "second",
  };
  const value = Math.max(1, Math.round(seconds / unit.divisor));
  return `${value} ${unit.label}${value === 1 ? "" : "s"}`;
}
