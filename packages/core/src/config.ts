/**
 * The website's server settings (session hand-over v1, "Set-up"). None of them
 * may reach the browser. A setting that is missing or malformed throws
 * `WebsiteKitConfigError` naming the SETTING, never its value: the client
 * secret must never appear in an error, a log or a page.
 */
import type { RequestView } from "./flows.ts";
import { savedPath } from "./saved-path.ts";

export interface WebsiteKitConfigInput {
  /** `ZWINGD_API_URL`: the API address, e.g. `https://api.example.com`. */
  apiUrl: string;
  /** `ZWINGD_APP_URL`: the workspace's app address, exactly as the platform team gave it. */
  appUrl: string;
  /** `ZWINGD_REALM`: the workspace's realm. */
  realm: string;
  /** `ZWINGD_SESSION_CLIENT_SECRET`: `zsh_` and 64 hex characters. */
  clientSecret: string;
  /** `ZWINGD_SITE_ORIGIN`: this website's origin, exactly as the platform team listed it. */
  origin: string;
  /**
   * Local development only: unprefixed cookie names without `Secure`, so an
   * `http://localhost` site works. Refused when `NODE_ENV` is `production`.
   */
  insecureLocalCookies?: boolean;
  /** Timeout of a server-to-server call. Default 10 s (the contract's value). */
  timeoutMs?: number;
  /** For tests: the `fetch` to call the API with. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** For tests: the clock, in milliseconds. Default: `Date.now`. */
  now?: () => number;
  /**
   * "Go to my account": a path inside the app that overrides the workspace's own
   * landing path (`signInOptions.landingPath`), e.g. `/communities/learning`.
   * A same-origin path under the saved-path rule, or the setting is refused.
   */
  accountPath?: string | null;
  /**
   * The app's page for ONE course by its code, with `:code` in it, e.g.
   * `/communities/courses/:code`. Without it a course link opens the member's
   * learning page (`/communities/learning`).
   */
  coursePath?: string | null;
  /**
   * v0.2.0 code step: the buyer's own IP from the request headers (lower-case
   * names), forwarded to the code calls as `buyerIp` (the code budget's
   * requester). Default `forwardedBuyerIp`: `x-real-ip`, else the LAST
   * `x-forwarded-for` hop (both set by the site's own proxy; never the first
   * hop, which the browser controls). Behind more than one proxy, pass your own. Anything that is not an IP is ignored.
   */
  buyerIpFrom?: BuyerIpResolver;
  /**
   * v0.2.0: the visitor's country (a master-data country id, 24 hex) for the
   * code step's quote and start with the proof, from the site's own source
   * (e.g. the host's geo header). Never the request body. `createMemberCheckout`
   * uses it too when it is not given its own. Default: none (the API's
   * pricing rule then decides).
   */
  visitorCountry?: VisitorCountryResolver | null;
}

/** The visitor's country as a master-data country id (24 hex), from the site's own source; null for none. */
export type VisitorCountryResolver = (req: RequestView) => string | null | undefined | Promise<string | null | undefined>;

/** Reads the buyer's IP from the request headers (lower-case names); null or undefined when unknown. */
export type BuyerIpResolver = (headers: Record<string, string | undefined>) => string | null | undefined;

export interface WebsiteKitConfig {
  apiUrl: string;
  appUrl: string;
  realm: string;
  clientSecret: string;
  origin: string;
  insecureLocalCookies: boolean;
  timeoutMs: number;
  fetch: typeof fetch;
  now: () => number;
  accountPath: string | null;
  coursePath: string | null;
  buyerIpFrom: BuyerIpResolver;
  visitorCountry: VisitorCountryResolver | null;
}

export class WebsiteKitConfigError extends Error {
  readonly setting: string;
  constructor(setting: string) {
    super(`Zwingd website kit: ${setting} is missing or not valid`);
    this.name = "WebsiteKitConfigError";
    this.setting = setting;
  }
}

export const DEFAULT_TIMEOUT_MS = 10_000;

const SECRET = /^zsh_[0-9a-f]{64}$/;
const REALM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An origin as the contract writes it: `https://<host>[:<port>]`, lower case, nothing after. */
function isOrigin(value: string, allowLocalHttp: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value || value !== value.toLowerCase()) return false;
  if (url.protocol === "https:") return true;
  return allowLocalHttp && url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
}

/** A base address: http(s), no credentials, no query or fragment. A trailing `/` is dropped. */
function baseUrl(value: unknown, setting: string, allowLocalHttp: boolean): string {
  if (typeof value !== "string" || value.trim() === "") throw new WebsiteKitConfigError(setting);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new WebsiteKitConfigError(setting);
  }
  const httpOk = allowLocalHttp && url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if ((url.protocol !== "https:" && !httpOk) || url.username || url.password || url.search || url.hash) {
    throw new WebsiteKitConfigError(setting);
  }
  return url.href.replace(/\/+$/, "");
}

/** An optional in-app path setting: absent, or a path the saved-path rule keeps exactly. */
function appPath(value: unknown, setting: string): string | null {
  if (value === undefined || value === null) return null;
  // savedPath answers "/" for anything unsafe, so a kept value equals its input.
  if (typeof value !== "string" || savedPath(value) !== value) throw new WebsiteKitConfigError(setting);
  return value;
}

function isProduction(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV === "production";
}

function coursePathOf(value: unknown): string | null {
  const path = appPath(value, "coursePath");
  if (path !== null && !path.includes(":code")) throw new WebsiteKitConfigError("coursePath");
  return path;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;

/** `value` when it is an IPv4 or IPv6 address (brackets dropped), else null. */
export function ipOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ip = value.trim().replace(/^\[(.*)\]$/, "$1");
  if (IPV4.test(ip)) return ip;
  if (ip.includes(":") && IPV6.test(ip)) return ip.toLowerCase();
  return null;
}

/**
 * The default `buyerIpFrom`: `x-real-ip`, else the LAST `x-forwarded-for` hop. Both are written by the site's own
 * proxy; the first hop is whatever the browser sent, so a caller could rotate it on every request and dodge the
 * per-requester code budget (spec v3.1 §4.4; PR #17 review). A site behind more than one proxy sets `buyerIpFrom`.
 */
export function forwardedBuyerIp(headers: Record<string, string | undefined>): string | null {
  const real = ipOf(headers["x-real-ip"]);
  if (real) return real;
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || forwarded.trim() === "") return null;
  const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
  return ipOf(hops[hops.length - 1]);
}

/** Check and complete the settings once, at start-up. */
export function resolveConfig(input: WebsiteKitConfigInput): WebsiteKitConfig {
  const local = input.insecureLocalCookies === true;
  if (local && isProduction()) throw new WebsiteKitConfigError("insecureLocalCookies (not allowed when NODE_ENV=production)");

  const apiUrl = baseUrl(input.apiUrl, "ZWINGD_API_URL", local);
  const appUrl = baseUrl(input.appUrl, "ZWINGD_APP_URL", local);
  if (typeof input.realm !== "string" || !REALM.test(input.realm)) throw new WebsiteKitConfigError("ZWINGD_REALM");
  if (typeof input.clientSecret !== "string" || !SECRET.test(input.clientSecret)) {
    throw new WebsiteKitConfigError("ZWINGD_SESSION_CLIENT_SECRET");
  }
  if (typeof input.origin !== "string" || !isOrigin(input.origin, local)) throw new WebsiteKitConfigError("ZWINGD_SITE_ORIGIN");

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new WebsiteKitConfigError("timeoutMs");
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new WebsiteKitConfigError("fetch");

  return {
    apiUrl,
    appUrl,
    realm: input.realm,
    clientSecret: input.clientSecret,
    origin: input.origin,
    insecureLocalCookies: local,
    timeoutMs,
    fetch: fetchImpl,
    now: input.now ?? Date.now,
    accountPath: appPath(input.accountPath, "accountPath"),
    coursePath: coursePathOf(input.coursePath),
    buyerIpFrom: buyerIpFromOf(input.buyerIpFrom),
    visitorCountry: visitorCountryOf(input.visitorCountry),
  };
}

function buyerIpFromOf(value: unknown): BuyerIpResolver {
  if (value === undefined || value === null) return forwardedBuyerIp;
  if (typeof value !== "function") throw new WebsiteKitConfigError("buyerIpFrom");
  return value as BuyerIpResolver;
}

function visitorCountryOf(value: unknown): VisitorCountryResolver | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "function") throw new WebsiteKitConfigError("visitorCountry");
  return value as VisitorCountryResolver;
}

/** The settings from the standard environment names (server side only). */
export function configFromEnv(
  env: Record<string, string | undefined>,
  extra: Partial<
    Pick<WebsiteKitConfigInput, "insecureLocalCookies" | "timeoutMs" | "fetch" | "now" | "accountPath" | "coursePath" | "buyerIpFrom" | "visitorCountry">
  > = {},
): WebsiteKitConfig {
  return resolveConfig({
    apiUrl: env.ZWINGD_API_URL ?? "",
    appUrl: env.ZWINGD_APP_URL ?? "",
    realm: env.ZWINGD_REALM ?? "",
    clientSecret: env.ZWINGD_SESSION_CLIENT_SECRET ?? "",
    origin: env.ZWINGD_SITE_ORIGIN ?? "",
    ...extra,
  });
}
