import { describe, expect, it } from "vitest";
import { createRedactor, redactUrlCredentials, Secret } from "./secret";

/**
 * The contract this file defends: a credential does not appear in output by
 * accident. Every test below is a path a secret would otherwise leak through —
 * interpolation, serialization, or a log line built from a template.
 */
describe("Secret", () => {
  const secret = new Secret("super-secret-token-value", "test token");

  it("only reveals its value when asked explicitly", () => {
    expect(secret.expose()).toBe("super-secret-token-value");
  });

  it("redacts itself on every implicit conversion", () => {
    expect(`${secret}`).toBe("[redacted test token]");
    expect(String(secret)).toBe("[redacted test token]");
    expect(secret.toString()).toBe("[redacted test token]");
    expect(JSON.stringify({ token: secret })).toBe('{"token":"[redacted test token]"}');
    expect(JSON.stringify([secret])).toBe('["[redacted test token]"]');
  });

  it("keeps the value off the object, so a spread cannot copy it out", () => {
    expect(JSON.stringify({ ...secret })).not.toContain("super-secret");
    expect(Object.values(secret)).not.toContain("super-secret-token-value");
  });

  it("reports length without revealing content", () => {
    expect(secret.length).toBe("super-secret-token-value".length);
  });
});

describe("createRedactor", () => {
  it("scrubs known secret values out of text", () => {
    const redact = createRedactor([new Secret("gho_abcdef123456", "forge token")]);
    expect(redact("cloning with gho_abcdef123456 now")).toBe("cloning with [redacted] now");
  });

  it("prefers the longest match, so an overlapping secret cannot survive", () => {
    // A short secret that is a prefix of a longer one would, if applied first,
    // leave the remainder of the longer secret exposed in the output.
    const redact = createRedactor(["token-1234", "token-1234-extended-suffix"]);
    expect(redact("value=token-1234-extended-suffix")).toBe("value=[redacted]");
  });

  it("replaces every occurrence, not just the first", () => {
    const redact = createRedactor(["repeated-secret"]);
    expect(redact("a repeated-secret b repeated-secret")).toBe("a [redacted] b [redacted]");
  });

  it("ignores values too short to be a real credential", () => {
    // Redacting "abc" would scrub ordinary prose and make logs useless.
    const redact = createRedactor(["abc"]);
    expect(redact("abc appears in alphabet")).toBe("abc appears in alphabet");
  });

  it("is a pass-through when there is nothing to redact", () => {
    expect(createRedactor([])("unchanged text")).toBe("unchanged text");
  });
});

describe("redactUrlCredentials", () => {
  it("strips credentials embedded in URLs, which is how git leaks tokens", () => {
    expect(
      redactUrlCredentials("fatal: https://x-access-token:ghs_secret@github.com/a/b.git"),
    ).toBe("fatal: https://***@github.com/a/b.git");
  });

  it("leaves clean URLs alone", () => {
    expect(redactUrlCredentials("https://github.com/a/b.git")).toBe(
      "https://github.com/a/b.git",
    );
  });
});
