import type { IngressAccept } from "./types";

/**
 * One inbound surface (REST webhook, GitHub, Teams, …).
 *
 * `accept` owns verification (signature / token) and normalization.
 * Auth helpers stay per-adapter until a shared pattern emerges.
 *
 * TODO(BA): decide whether a shared HMAC/signature helper belongs in the
 * controller or stays adapter-local.
 */
export interface IngressAdapter {
  readonly kind: string;

  /**
   * Verify and normalize a foreign request.
   * Return null when this adapter does not handle the payload (or rejects it).
   */
  accept(input: unknown): Promise<IngressAccept | null>;
}
