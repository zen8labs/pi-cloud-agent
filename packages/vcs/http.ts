import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "@pi-cloud-agent/protocol";

/** Shared helpers for talking to forges and authenticating their webhooks. */

export const REQUEST_TIMEOUT_MS = 30_000;

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = init;
  const response = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${init.method ?? "GET"} ${url} failed: ${response.status} ${body.slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Unequal lengths short-circuit, which is safe: length is not the secret.
 */
export function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify an HMAC-SHA256 body signature.
 *
 * Fails closed in every ambiguous case — no configured secret, no signature
 * header, wrong length — because "we could not check" and "it is authentic" must
 * never take the same branch.
 */
export function verifyHmacSignature(options: {
  secret: string;
  signature: string | null;
  body: string;
  prefix: string;
  headerName: string;
}): void {
  const { secret, signature, body, prefix, headerName } = options;
  if (!secret) {
    throw new WebhookVerificationError(`webhook secret is not configured (need ${headerName})`);
  }
  if (!signature) {
    throw new WebhookVerificationError(`missing ${headerName} header`);
  }
  const expected = prefix + createHmac("sha256", secret).update(body).digest("hex");
  if (!secureEquals(expected, signature)) {
    throw new WebhookVerificationError(`invalid ${headerName} signature`);
  }
}

/** Never throws on a missing header; callers decide what absence means. */
export function header(headers: Headers, name: string): string | null {
  return headers.get(name);
}
