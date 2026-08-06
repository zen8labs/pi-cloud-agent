import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ResolveHostname = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

/** Validate a model endpoint before the trusted controller makes a request. */
export async function assertSafeLlmEndpoint(
  value: string,
  resolveHostname: ResolveHostname = resolveAll,
): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("model endpoint must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("base URL must not contain embedded credentials");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isBlockedHostname(hostname)) {
    throw new Error("model endpoint must resolve to a public address");
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolveHostname(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("model endpoint must resolve to a public address");
  }
  return url;
}

async function resolveAll(hostname: string) {
  return lookup(hostname, { all: true, verbatim: true });
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first, second, third] = octets;
  if (first === undefined || second === undefined || third === undefined) return false;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 192 && second === 0 && third <= 7) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const words = parseIpv6(address);
  if (!words) return false;
  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  const allZero = words.every((word) => word === 0);
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const isMappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const isCompatibleIpv4 = words.slice(0, 6).every((word) => word === 0);
  return !(
    allZero ||
    isLoopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second >= 0xdb00 && second <= 0xdbff) ||
    ((isMappedIpv4 || isCompatibleIpv4) && isPrivateEmbeddedIpv4(words))
  );
}

function isPrivateEmbeddedIpv4(words: number[]): boolean {
  const [sixth, seventh] = [words[6], words[7]];
  if (sixth === undefined || seventh === undefined) return true;
  return !isPublicIpv4(`${sixth >> 8}.${sixth & 255}.${seventh >> 8}.${seventh & 255}`);
}

function parseIpv6(address: string): number[] | null {
  const normalized = expandIpv4Suffix(address.toLowerCase());
  if (!normalized) return null;

  const sections = normalized.split("::");
  if (sections.length > 2) return null;
  const left = parseIpv6Section(sections[0] ?? "");
  const right = parseIpv6Section(sections[1] ?? "");
  if (!left || !right) return null;
  if (sections.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing > 0 ? [...left, ...Array(missing).fill(0), ...right] : null;
}

function expandIpv4Suffix(address: string): string | null {
  if (!address.includes(".")) return address;
  const separator = address.lastIndexOf(":");
  const octets = address
    .slice(separator + 1)
    .split(".")
    .map(Number);
  if (
    separator < 1 ||
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet))
  ) {
    return null;
  }
  const [first, second, third, fourth] = octets;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    return null;
  }
  const high = (first << 8) | second;
  const low = (third << 8) | fourth;
  return `${address.slice(0, separator)}:${high.toString(16)}:${low.toString(16)}`;
}

function parseIpv6Section(section: string): number[] | null {
  if (!section) return [];
  const words = section.split(":").map((word) => Number.parseInt(word, 16));
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}
