import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

type LookupResult = { address: string; family: number };
type LookupAll = (hostname: string) => Promise<LookupResult[]>;

const lookupAll: LookupAll = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function ipv4Number(address: string): number | undefined {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function inV4Range(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4Number(base)!;
  const mask = bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

export function isPublicIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  if (parsed instanceof ipaddr.IPv4) {
    const value = ipv4Number(parsed.toString())!;
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, bits]) => inV4Range(value, base, bits));
  }

  if (parsed.range() !== "unicast") return false;
  const additionalBlockedRanges = ["100::/64", "3fff::/20", "5f00::/16"].map((cidr) => ipaddr.parseCIDR(cidr));
  return !additionalBlockedRanges.some((range) => parsed.match(range as [ipaddr.IPv6, number]));
}

export async function assertPublicHttpUrl(input: string, resolver: LookupAll = lookupAll): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("URL must be a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  if ((url.protocol === "http:" && url.port && url.port !== "80") ||
      (url.protocol === "https:" && url.port && url.port !== "443")) {
    throw new Error("Only standard HTTP and HTTPS ports are allowed.");
  }

  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await resolver(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("The URL resolves to a private, local, reserved, or otherwise unsafe network address.");
  }
  return url;
}
