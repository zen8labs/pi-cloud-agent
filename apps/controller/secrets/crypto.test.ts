import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("VCS token encryption", () => {
  it("round-trips a token with authenticated encryption", () => {
    const encrypted = encryptSecret("oauth-token", KEY);

    expect(encrypted).not.toContain("oauth-token");
    expect(decryptSecret(encrypted, KEY)).toBe("oauth-token");
  });

  it("rejects invalid keys and tampered ciphertext", () => {
    expect(() => encryptSecret("oauth-token", "not-a-key")).toThrow();
    const encrypted = encryptSecret("oauth-token", KEY);
    const tampered = (encrypted.startsWith("A") ? "B" : "A") + encrypted.slice(1);

    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });
});
