import type { RepoRef, TaskSpec, Trigger } from "@pi-cloud-agent/protocol";
import type { IngressAdapter } from "./ingress";
import type { ReportSink } from "./report";
import type { IngressAccept, SurfaceRef, SurfaceReport } from "./types";
import { surfaceRefSchema } from "./types";

/** Test / design-double surface kind. Not a product integration. */
export const MEMORY_SURFACE_KIND = "memory" as const;

interface MemoryIngressInput {
  secret: string;
  prompt: string;
  repo: RepoRef;
  /** Optional opaque payload stored on the SurfaceRef for wake/callback tests. */
  surfacePayload?: Record<string, unknown>;
}

/**
 * In-memory ingress + sink for proving the ZEN-92 round-trip without forges.
 * Product adapters (REST / GitHub / Teams) land in ZEN-93–95.
 */
export class MemoryIngressAdapter implements IngressAdapter {
  readonly kind = MEMORY_SURFACE_KIND;

  constructor(private readonly expectedSecret: string) {}

  async accept(input: unknown): Promise<IngressAccept | null> {
    if (!isMemoryIngressInput(input)) return null;
    if (input.secret !== this.expectedSecret) return null;

    const trigger: Trigger = {
      kind: "manual",
      repo: input.repo,
      prompt: input.prompt,
    };
    const taskSpec: TaskSpec = {
      prompt: input.prompt,
      repo: input.repo,
    };
    const surface: SurfaceRef = surfaceRefSchema.parse({
      kind: MEMORY_SURFACE_KIND,
      payload: input.surfacePayload ?? {},
    });
    return { trigger, taskSpec, surface };
  }
}

export class MemoryReportSink implements ReportSink {
  readonly kind = MEMORY_SURFACE_KIND;
  readonly reports: SurfaceReport[] = [];

  supports(surface: SurfaceRef): boolean {
    return surface.kind === MEMORY_SURFACE_KIND;
  }

  async report(_surface: SurfaceRef, report: SurfaceReport): Promise<void> {
    this.reports.push(report);
  }
}

function isMemoryIngressInput(input: unknown): input is MemoryIngressInput {
  if (input === null || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return (
    typeof value.secret === "string" &&
    typeof value.prompt === "string" &&
    value.repo !== null &&
    typeof value.repo === "object"
  );
}
