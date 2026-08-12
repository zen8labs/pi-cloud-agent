import type { IngressAdapter } from "./ingress";
import type { ReportSink } from "./report";
import type { SurfaceRef } from "./types";

/**
 * In-process registry of ingress adapters and report sinks.
 *
 * TODO(BA): wire into HTTP dispatch + reconciler/internal status once
 * `SurfaceRef` persistence on the run row is approved (schema migration).
 */
export class IntegrationRegistry {
  private readonly adapters = new Map<string, IngressAdapter>();
  private readonly sinks = new Map<string, ReportSink>();

  registerAdapter(adapter: IngressAdapter): void {
    if (this.adapters.has(adapter.kind)) {
      throw new Error(`ingress adapter already registered: ${adapter.kind}`);
    }
    this.adapters.set(adapter.kind, adapter);
  }

  registerSink(sink: ReportSink): void {
    if (this.sinks.has(sink.kind)) {
      throw new Error(`report sink already registered: ${sink.kind}`);
    }
    this.sinks.set(sink.kind, sink);
  }

  getAdapter(kind: string): IngressAdapter | null {
    return this.adapters.get(kind) ?? null;
  }

  /** Prefer a sink whose kind matches the surface; else the first that supports it. */
  resolveSink(surface: SurfaceRef): ReportSink | null {
    const byKind = this.sinks.get(surface.kind);
    if (byKind?.supports(surface)) return byKind;
    for (const sink of this.sinks.values()) {
      if (sink.supports(surface)) return sink;
    }
    return null;
  }
}
