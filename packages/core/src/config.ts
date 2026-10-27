/**
 * The website's server settings (session hand-over v1, "Set-up"). None of them
 * may reach the browser. A setting that is missing or malformed throws
 * `WebsiteKitConfigError` naming the SETTING, never its value: the client
 * secret must never appear in an error, a log or a page.
 */

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
}

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

function isProduction(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV === "production";
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
  };
}

/** The settings from the standard environment names (server side only). */
export function configFromEnv(
  env: Record<string, string | undefined>,
  extra: Partial<Pick<WebsiteKitConfigInput, "insecureLocalCookies" | "timeoutMs" | "fetch" | "now">> = {},
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
