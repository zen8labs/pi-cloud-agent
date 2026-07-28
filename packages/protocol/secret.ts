/**
 * A credential that has to be opened deliberately.
 *
 * Once code runs inside a sandbox with a token in its environment, that token
 * is compromised in principle — the real controls are narrow scope, short TTL,
 * and isolation. This type is not a security boundary. It exists so that
 * *leaking a secret into a log line, an event payload, or an error message* is
 * a type error rather than a code-review miss, because the accidental paths
 * (string interpolation, `JSON.stringify`, console) all go through
 * `toString`/`toJSON` and get "[redacted]".
 *
 * See docs/secrets.md.
 */
export class Secret<T extends string = string> {
  readonly #value: T;
  /** Where this came from, for diagnostics. Never the value itself. */
  readonly label: string;

  constructor(value: T, label: string) {
    this.#value = value;
    this.label = label;
  }

  /** Open the envelope. Call this at the point of use and nowhere earlier. */
  expose(): T {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return `[redacted ${this.label}]`;
  }

  toJSON(): string {
    return `[redacted ${this.label}]`;
  }

  get [Symbol.toStringTag](): string {
    return `Secret(${this.label})`;
  }
}

/**
 * Build a function that scrubs known secret values out of text on its way to
 * durable storage. Longest-first so a secret that contains another secret as a
 * prefix still redacts fully.
 *
 * This is the one chokepoint: everything written to the event log passes
 * through it (see apps/controller/http/internal.ts).
 */
export function createRedactor(secrets: Iterable<Secret | string>): (text: string) => string {
  const values = [...secrets]
    .map((s) => (typeof s === "string" ? s : s.expose()))
    // Very short values would scrub half the log. A real credential is long.
    .filter((v) => v.length >= 8)
    .sort((a, b) => b.length - a.length);

  if (values.length === 0) return (text) => text;

  return (text) => {
    let out = text;
    for (const value of values) out = out.replaceAll(value, "[redacted]");
    return out;
  };
}

/** Strip `user:token@` credentials out of URLs, e.g. in git's stderr. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^/\s@]+@/g, "$1***@");
}
