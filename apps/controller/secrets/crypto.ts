import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/** Encrypt one OAuth secret for database storage with the deployment key. */
export function encryptSecret(value: string, encryptionKey: string): string {
  const key = keyBytes(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

/** Decrypt one OAuth secret, failing closed when the deployment key is wrong. */
export function decryptSecret(value: string, encryptionKey: string): string {
  const [ivText, tagText, ciphertextText] = value.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("invalid encrypted VCS secret");
  const decipher = createDecipheriv(
    ALGORITHM,
    keyBytes(encryptionKey),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function keyBytes(value: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("encryption key must be 64 hexadecimal characters");
  }
  return Buffer.from(value, "hex");
}
