/**
 * The three website routes (session hand-over v1, "The three website routes")
 * as pure functions: a request view in, a response view out. Every framework
 * adapter is a thin translation of these.
 *
 *   GET  /session/start     302 to the app's hand-over, `prompt=login` always.
 *   GET  /session/callback  state checked against the start cookie, ONE
 *                           exchange, 303 to the saved path. Renders nothing.
 *   POST /session/end       same-site POST only; ends the session on the API,
 *                           clears the cookies whatever the answer, 303 to the
 *                           app's sign-out.
 *
 * Every answer carries `Cache-Control: no-store` and `Referrer-Policy:
 * no-referrer`. No token, secret, verifier or code is ever logged, thrown or
 * put in a URL other than the contract's own redirects.
 */
import { endSession, exchangeCode, isSessionToken } from "./api-client.ts";
import { resolveConfig, type WebsiteKitConfig, type WebsiteKitConfigInput } from "./config.ts";
import {
  clearCookie,
  cookieNames,
  type CookieNames,
  serializeCookie,
  START_COOKIE_MAX_AGE_S,
} from "./cookies.ts";
import { createMemberReader, type MemberCheck, type MemberReader } from "./member.ts";
import { base64url, codeChallenge, randomToken, STATE_LENGTH, STATE_PATTERN, VERIFIER_LENGTH, VERIFIER_PATTERN } from "./pkce.ts";
import { savedPath } from "./saved-path.ts";

export const SESSION_PATHS = Object.freeze({ start: "/session/start", callback: "/session/callback", end: "/session/end" });

/** The form field the sign-out form carries the CSRF value in. */
export const CSRF_FIELD = "csrf";
export const CSRF_COOKIE_MAX_AGE_S = 24 * 60 * 60;

export interface RequestView {
  method: string;
  /** The full request URL; only its path and query are read. */
  url: string;
  cookies: Record<string, string>;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  /** The parsed `application/x-www-form-urlencoded` body of a POST, if any. */
  form?: Record<string, string>;
}

export interface ResponseView {
  status: number;
  headers: Record<string, string>;
  /** One entry per `Set-Cookie` header. */
  setCookies: string[];
}

const CODE = /^[0-9a-f]{64}$/;
const CSRF_VALUE = /^[A-Za-z0-9\-._~]{32,128}$/;

const baseHeaders = (): Record<string, string> => ({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
const redirect = (status: 302 | 303, location: string, setCookies: string[]): ResponseView => ({
  status,
  headers: { ...baseHeaders(), Location: location },
  setCookies,
});

interface StartState {
  state: string;
  verifier: string;
  path: string;
}

function encodeStart(start: StartState): string {
  return base64url(new TextEncoder().encode(JSON.stringify({ s: start.state, v: start.verifier, p: start.path })));
}

function decodeStart(raw: string | undefined): StartState | null {
  if (!raw || !/^[A-Za-z0-9_-]{1,4096}$/.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((raw.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes)) as { s?: unknown; v?: unknown; p?: unknown };
    if (typeof data.s !== "string" || !STATE_PATTERN.test(data.s)) return null;
    if (typeof data.v !== "string" || !VERIFIER_PATTERN.test(data.v)) return null;
    return { state: data.s, verifier: data.v, path: savedPath(data.p) };
  } catch {
    return null;
  }
}

/** Header lookup that tolerates any casing an adapter hands in. */
function header(req: RequestView, name: string): string | undefined {
  const direct = req.headers[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(req.headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : req.headers[key];
}

export interface WebsiteKit extends MemberReader {
  readonly config: WebsiteKitConfig;
  readonly cookieNames: CookieNames;
  start(req: RequestView): Promise<ResponseView>;
  callback(req: RequestView): Promise<ResponseView>;
  end(req: RequestView): Promise<ResponseView>;
  /** Route a request to start / callback / end; null when the path is not one of the three. */
  handle(req: RequestView): Promise<ResponseView | null>;
  /**
   * The value the sign-out form posts as `csrf`. When the browser has none yet
   * (a cookie lost or cleared), a new one is made and `setCookie` must be sent.
   */
  csrfFor(cookies: Record<string, string>): { token: string; setCookie: string | null };
  /** The `Set-Cookie` that drops the session, for an adapter that saw `getMember` answer `ended`. */
  clearSessionCookie(): string;
}

export function createWebsiteKit(input: WebsiteKitConfigInput | WebsiteKitConfig): WebsiteKit {
  const config = resolveConfig(input);
  const names = cookieNames(config.insecureLocalCookies);
  const local = config.insecureLocalCookies;
  const members = createMemberReader(config, names);

  const clearStart = () => clearCookie(names.start, "Lax", local);
  const clearSession = () => clearCookie(names.session, "Lax", local);
  const clearCsrf = () => clearCookie(names.csrf, "Strict", local);
  const appSignOutFallback = () => `${config.appUrl}/session/sign-out?return_origin=${encodeURIComponent(config.origin)}`;

  async function start(req: RequestView): Promise<ResponseView> {
    if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, headers: { ...baseHeaders(), Allow: "GET" }, setCookies: [] };
    const next = new URL(req.url, config.origin).searchParams.get("next");
    const state = randomToken(STATE_LENGTH);
    const verifier = randomToken(VERIFIER_LENGTH);
    const target = new URL(`${config.appUrl}/session/handover`);
    target.searchParams.set("return_origin", config.origin);
    target.searchParams.set("state", state);
    target.searchParams.set("code_challenge", await codeChallenge(verifier));
    target.searchParams.set("code_challenge_method", "S256");
    // v1 operator rule for this kit: always `login`, never a silent check; any
    // `prompt` in the request is ignored.
    target.searchParams.set("prompt", "login");
    const cookie = serializeCookie(
      names.start,
      encodeStart({ state, verifier, path: savedPath(next) }),
      { sameSite: "Lax", maxAge: START_COOKIE_MAX_AGE_S },
      local,
    );
    return redirect(302, target.href, [cookie]);
  }

  async function callback(req: RequestView): Promise<ResponseView> {
    if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, headers: { ...baseHeaders(), Allow: "GET" }, setCookies: [] };
    const params = new URL(req.url, config.origin).searchParams;
    const saved = decodeStart(req.cookies[names.start]);
    const state = params.get("state");
    // No start cookie, or a state that is not ours: refuse (a redirect home,
    // nothing rendered). The start cookie is kept, so a forged callback cannot
    // break an honest sign-in that is still in progress.
    if (!saved || state === null || state !== saved.state) return redirect(303, "/", []);

    // `login_required`, `temporarily_unavailable` or anything else: carry on signed out.
    if (params.has("error")) return redirect(303, saved.path, [clearStart()]);

    const code = params.get("code");
    if (code === null || !CODE.test(code)) return redirect(303, saved.path, [clearStart()]);

    // Exactly ONE exchange per code. A failure is never retried: a second
    // presentation would end the session the first one created.
    const res = await exchangeCode(config, code, saved.verifier);
    if (!res.ok) return redirect(303, saved.path, [clearStart()]);

    const now = config.now();
    const expiresAt = new Date(res.body.expiresAt);
    const maxAge = Math.floor((expiresAt.getTime() - now) / 1000);
    if (maxAge <= 0) return redirect(303, saved.path, [clearStart()]);
    await members.remember(res.body.sessionToken, res.body.member);
    return redirect(303, saved.path, [
      serializeCookie(names.session, res.body.sessionToken, { sameSite: "Lax", maxAge, expires: expiresAt }, local),
      serializeCookie(names.csrf, randomToken(43), { sameSite: "Strict", maxAge: Math.min(maxAge, CSRF_COOKIE_MAX_AGE_S) }, local),
      clearStart(),
    ]);
  }

  /** A same-site POST: no cross-site Origin / Sec-Fetch-Site, AND the Strict cookie's value in the form. */
  function sameSiteForm(req: RequestView): boolean {
    const origin = header(req, "origin");
    if (origin !== undefined && origin !== config.origin) return false;
    const site = header(req, "sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return false;
    const cookie = req.cookies[names.csrf];
    const sent = req.form?.[CSRF_FIELD];
    return typeof cookie === "string" && CSRF_VALUE.test(cookie) && sent === cookie;
  }

  async function end(req: RequestView): Promise<ResponseView> {
    // A GET never ends anything.
    if (req.method !== "POST") return { status: 405, headers: { ...baseHeaders(), Allow: "POST" }, setCookies: [] };
    if (!sameSiteForm(req)) return { status: 403, headers: baseHeaders(), setCookies: [] };

    const token = req.cookies[names.session];
    let location = appSignOutFallback();
    if (isSessionToken(token)) {
      await members.forget(token);
      const res = await endSession(config, token);
      const url = res.ok ? res.body.appSignOutUrl : null;
      if (url && /^https?:\/\//.test(url)) location = url;
    }
    // Cleared whatever the API answered: the member is never left signed in on the website.
    return redirect(303, location, [clearSession(), clearCsrf()]);
  }

  return {
    config,
    cookieNames: names,
    start,
    callback,
    end,
    async handle(req) {
      const path = new URL(req.url, config.origin).pathname;
      if (path === SESSION_PATHS.start) return start(req);
      if (path === SESSION_PATHS.callback) return callback(req);
      if (path === SESSION_PATHS.end) return end(req);
      return null;
    },
    csrfFor(cookies) {
      const existing = cookies[names.csrf];
      if (typeof existing === "string" && CSRF_VALUE.test(existing)) return { token: existing, setCookie: null };
      const token = randomToken(43);
      return { token, setCookie: serializeCookie(names.csrf, token, { sameSite: "Strict", maxAge: CSRF_COOKIE_MAX_AGE_S }, local) };
    },
    clearSessionCookie: clearSession,
    getMember: members.getMember,
    freshMember: members.freshMember,
    remember: members.remember,
    forget: members.forget,
  };
}

export type { MemberCheck };
