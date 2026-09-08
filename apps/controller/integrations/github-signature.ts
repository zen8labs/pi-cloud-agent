import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGithubSignature(
  body: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    "utf8",
  );
  const actual = Buffer.from(signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
