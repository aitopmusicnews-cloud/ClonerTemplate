import * as cheerio from "cheerio";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { assertPublicHttpUrl } from "../security/public-url.js";
import { isPublicIp } from "../security/public-url.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

type InspectionBody = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<unknown>;
  };
};
type InspectionResponse = {
  body: InspectionBody | null;
  headers: { get(name: string): string | null };
  ok: boolean;
  status: number;
};
type InspectionFetcher = (url: URL, init: {
  redirect: "manual";
  signal: AbortSignal;
  headers: Record<string, string>;
}) => Promise<InspectionResponse>;

type AddressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultAddressResolver: AddressResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export function createSafeLookup(resolver: AddressResolver = defaultAddressResolver): LookupFunction {
  return (hostname, options, callback) => {
    void resolver(hostname).then((addresses) => {
      if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
        const error = new Error("The URL resolved to a private, local, reserved, or otherwise unsafe network address.") as NodeJS.ErrnoException;
        error.code = "ENETUNREACH";
        callback(error, "", 0);
        return;
      }

      const requestedFamily = typeof options === "object" && options.family ? Number(options.family) : 0;
      const candidates = requestedFamily ? addresses.filter(({ family }) => family === requestedFamily) : addresses;
      if (candidates.length === 0) {
        const error = new Error("The URL did not resolve to a usable public network address.") as NodeJS.ErrnoException;
        error.code = "ENETUNREACH";
        callback(error, "", 0);
        return;
      }

      if (typeof options === "object" && options.all) callback(null, candidates);
      else callback(null, candidates[0]!.address, candidates[0]!.family);
    }).catch((error: unknown) => callback(error as NodeJS.ErrnoException, "", 0));
  };
}

const safeDispatcher = new Agent({ connect: { lookup: createSafeLookup() } });
const safeFetcher: InspectionFetcher = async (url, init) => undiciFetch(url, {
  ...init,
  dispatcher: safeDispatcher,
});

export type SiteInspection = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  description: string;
  language: string;
  headings: Array<{ level: number; text: string }>;
  navigation: Array<{ text: string; url: string }>;
  images: Array<{ alt: string; url: string }>;
  colors: string[];
  fontFamilies: string[];
  forms: number;
  textSample: string;
  inspectedAt: string;
  warnings: string[];
};

async function readLimitedBody(response: InspectionResponse): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error("The page is larger than the 2 MB inspection limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("The page is larger than the 2 MB inspection limit.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchHtml(input: string, fetcher: InspectionFetcher = safeFetcher): Promise<{ html: string; finalUrl: URL }> {
  let current = await assertPublicHttpUrl(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetcher(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "ClonerTemplate-MCP/0.1 (+authorized-design-inspection)",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Website returned redirect ${response.status} without a location.`);
      if (redirects === MAX_REDIRECTS) throw new Error("Website exceeded the redirect limit.");
      current = await assertPublicHttpUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Website returned HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("The target did not return an HTML document.");
    }
    return { html: await readLimitedBody(response), finalUrl: current };
  }
  throw new Error("Unable to inspect the website.");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function absoluteWebUrl(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined;
  try {
    const resolved = new URL(value, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
    resolved.username = "";
    resolved.password = "";
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))].slice(0, limit);
}

export async function inspectSite(input: {
  url: string;
  authorizationConfirmed: boolean;
  fetcher?: InspectionFetcher;
}): Promise<SiteInspection> {
  if (!input.authorizationConfirmed) {
    throw new Error("Inspection requires confirmation that the user owns the website or has permission to recreate it.");
  }
  const { html, finalUrl } = await fetchHtml(input.url, input.fetcher);
  const $ = cheerio.load(html);
  $("script, noscript, template, svg").remove();

  const headings = $("h1, h2, h3, h4, h5, h6").toArray().map((element) => ({
    level: Number(element.tagName.slice(1)),
    text: normalizeText($(element).text()),
  })).filter(({ text }) => text.length > 0).slice(0, 40);

  const navigation = $("nav a, header a").toArray().map((element) => ({
    text: normalizeText($(element).text()).slice(0, 160),
    url: absoluteWebUrl($(element).attr("href"), finalUrl),
  })).filter((item): item is { text: string; url: string } => Boolean(item.text && item.url))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url && candidate.text === item.text) === index)
    .slice(0, 30);

  const images = $("img").toArray().map((element) => ({
    alt: normalizeText($(element).attr("alt") || "").slice(0, 240),
    url: absoluteWebUrl($(element).attr("src"), finalUrl),
  })).filter((item): item is { alt: string; url: string } => Boolean(item.url)).slice(0, 30);

  const styleText = `${$("style").text()} ${$("[style]").toArray().map((element) => $(element).attr("style")).join(" ")}`;
  const colors = unique(styleText.match(/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]{1,80}\)/gi) || [], 24);
  const fontFamilies = unique([...styleText.matchAll(/font-family\s*:\s*([^;}]+)/gi)].map((match) => match[1] || ""), 16);

  return {
    requestedUrl: input.url,
    finalUrl: finalUrl.toString(),
    title: normalizeText($("title").first().text()).slice(0, 300),
    description: normalizeText($("meta[name='description']").attr("content") || "").slice(0, 500),
    language: normalizeText($("html").attr("lang") || "").slice(0, 40),
    headings,
    navigation,
    images,
    colors,
    fontFamilies,
    forms: $("form").length,
    textSample: normalizeText($("body").text()).slice(0, 1_500),
    inspectedAt: new Date().toISOString(),
    warnings: [
      "Inspection reads public HTML only; client-rendered or authenticated content may be incomplete.",
      "Use only content and assets the user owns, provides, or is licensed to reproduce.",
    ],
  };
}
