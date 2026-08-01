/** Shared helpers for talking to forges. */

const REQUEST_TIMEOUT_MS = 30_000;

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
