import "server-only";

import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

// The login rate limit is keyed per client without storing raw IP addresses:
// the key is a hash salted with SESSION_SECRET, so the stored value cannot be
// reversed by enumerating the IPv4 space without the secret (D-014, D-059).

const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0xffff] as const;

/** The eight 16-bit groups of a valid IPv6 address (zone index removed). */
function ipv6Groups(address: string): number[] {
  let text = address.split("%")[0] ?? address;
  // A trailing dotted IPv4 part ("::ffff:192.0.2.1") is two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16)));
  const front = parse(head);
  if (rest === undefined) return front;
  const back = parse(rest);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/**
 * The address the rate limit counts against. IPv4 stays as it is. An IPv6
 * address counts as its /64 network, because one host routinely holds a whole
 * /64 and could otherwise rotate through 2^64 addresses with 5 guesses each.
 * An IPv4-mapped IPv6 address ("::ffff:192.0.2.1") counts as its IPv4 address.
 * Anything that is not an IP address (such as "unknown") is returned unchanged.
 */
export function rateLimitAddress(ip: string): string {
  const address = ip.trim();
  if (isIPv4(address) || !isIPv6(address)) return address;

  const groups = ipv6Groups(address.toLowerCase());
  if (IPV4_MAPPED_PREFIX.every((value, index) => groups[index] === value)) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The rate-limit key for a client: hex sha256 of `rateLimitAddress(ip)|secret`. */
export function clientKeyHash(ip: string, secret: string): string {
  return createHash("sha256").update(`${rateLimitAddress(ip)}|${secret}`, "utf8").digest("hex");
}

/**
 * The client IP from proxy headers: the first `x-forwarded-for` entry, then
 * `x-real-ip`, otherwise one shared "unknown" bucket.
 *
 * This is only trustworthy behind a proxy that overwrites both headers, as
 * Vercel does. `next start` fills `x-forwarded-for` from the socket only when
 * the request does not already carry one, so a self-hosted server reached
 * directly (or behind a proxy that appends instead of overwriting) lets every
 * client choose its own key: rotating it gives unlimited guesses, and copying
 * the owner's address locks the owner out (D-059).
 */
export function getClientIp(headers: Pick<Headers, "get">): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const real = headers.get("x-real-ip")?.trim();
  return real || "unknown";
}
