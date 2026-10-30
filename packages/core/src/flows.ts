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
 *                           app's sign-out. The form's `next` (the page it was
 *                           on, under the saved-path rule) is kept in a
 *                           10-minute cookie: the app returns the browser to
 *                           `<origin>/`, where `signOutReturn` sends it on.
 *   GET  /session/me        same-origin only; who is signed in, by name, as
 *                           JSON, through the 60 s check cache. For pages
 *                           that are cached or static and read the member in
 *                           the browser.
 *
 * v0.2.0 adds the code step before payment and the thank-you continue
 * (code-routes.ts, checkout v3.2): /session/code-step, /session/code-start,
 * /session/code-resend, /session/code-verify, /session/code-pay and
 * /session/checkout-continue.
 *
 * Every answer carries `Cache-Control: no-store` and `Referrer-Policy:
 * no-referrer`. No token, secret, verifier or code is ever logged, thrown or
 * put in a URL other than the contract's own redirects.
 */
import { endSession, exchangeCode, isSessionToken } from "./api-client.ts";
import { createAccountLinks } from "./account.ts";
import { CODE_PATHS, createCodeRoutes, type CheckoutContinue } from "./code-routes.ts";
import { resolveConfig, type WebsiteKitConfig, type WebsiteKitConfigInput } from "./config.ts";
import {
  clearCookie,
  cookieNames,
  type CookieNames,
  RETURN_COOKIE_MAX_AGE_S,
  serializeCookie,
  START_COOKIE_MAX_AGE_S,
} from "./cookies.ts";
import { createMemberReader, type MemberCheck, type MemberReader } from "./member.ts";
import { base64url, codeChallenge, randomToken, STATE_LENGTH, STATE_PATTERN, VERIFIER_LENGTH, VERIFIER_PATTERN } from "./pkce.ts";
import { CSRF_VALUE, header, sameSitePost } from "./same-site.ts";
import { savedPath } from "./saved-path.ts";

export const SESSION_PATHS = Object.freeze({
  start: "/session/start",
  callback: "/session/callback",
  end: "/session/end",
  me: "/session/me",
  ...CODE_PATHS,
});

/** The form field the sign-out form carries the CSRF value in (same-site.ts owns the rule). */
export { CSRF_FIELD } from "./same-site.ts";
/** A CSRF cookie minted outside a sign-in, where the session's expiry is not known. */
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
  /** A text body (the JSON routes: `/session/me`, the code step). */
  body?: string;
}

/** What `GET /session/me` answers. */
export interface SessionMe {
  /** The name only, or null when nobody is signed in. */
  member: { firstName?: string; lastName?: string } | null;
  /** The sign-out form's `csrf` value while signed in, else null. */
  signOutToken: string | null;
  /** While signed in: where "Go to my account" opens (`<ZWINGD_APP_URL><path>`, kit #11); else null. */
  accountUrl: string | null;
}

/** The sign-out form's field for the page it was on (kit #10). */
export const SIGN_OUT_NEXT_FIELD = "next";

const CODE = /^[0-9a-f]{64}$/;

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

function encodePath(path: string): string {
  return base64url(new TextEncoder().encode(path));
}

/** The kept path, checked again with the saved-path rule; null when unreadable. */
function decodePath(raw: string | undefined): string | null {
  if (!raw || !/^[A-Za-z0-9_-]{1,1024}$/.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((raw.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return savedPath(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
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


export interface WebsiteKit extends MemberReader {
  readonly config: WebsiteKitConfig;
  readonly cookieNames: CookieNames;
  start(req: RequestView): Promise<ResponseView>;
  callback(req: RequestView): Promise<ResponseView>;
  end(req: RequestView): Promise<ResponseView>;
  me(req: RequestView): Promise<ResponseView>;
  /** v0.2.0 `GET /session/code-step`: the code step's form value and the open step a reload resumes. */
  codeStep(req: RequestView): Promise<ResponseView>;
  /** v0.2.0 `POST /session/code-start` (same-site POST + CSRF). */
  codeStart(req: RequestView): Promise<ResponseView>;
  /** v0.2.0 `POST /session/code-resend` (same-site POST + CSRF); an expired ticket starts again with the stored email. */
  codeResend(req: RequestView): Promise<ResponseView>;
  /** v0.2.0 `POST /session/code-verify` (same-site POST + CSRF): proof cookie, re-quote, and payment or the new price. No session. */
  codeVerify(req: RequestView): Promise<ResponseView>;
  /** v0.2.0 `POST /session/code-pay` (same-site POST + CSRF): "Pay {amount}" with the held proof. */
  codePay(req: RequestView): Promise<ResponseView>;
  /** v0.2.0 `POST /session/code-requote` (same-site POST + CSRF): a reload with the proof held, re-quoted for "Pay {amount}". */
  codeRequote(req: RequestView): Promise<ResponseView>;
  /**
   * v0.2.0 `POST /session/checkout-continue` (same-site POST + CSRF): the thank-you press with `orderId`; mints the
   * nonce and answers `{ nonce, continueUrl }`.
   */
  checkoutContinue(req: RequestView): Promise<ResponseView>;
  /**
   * v0.2.0, server only: the thank-you button ("Continue sign-up" / "Go to my
   * course") for the order on the page, from a server-side read of the proof
   * context, or null when this browser holds no proof that is still good, the
   * held proof did not start `orderId` in this browser (Helm #26, a kit-only
   * check), or the context read fails (an API fault). Never mints a nonce.
   */
  checkoutContinueFor(cookies: Record<string, string>, input: { orderId: string }): Promise<CheckoutContinue | null>;
  /** Route a request to any /session/* route above; null when the path is none of them. */
  handle(req: RequestView): Promise<ResponseView | null>;
  /**
   * The value the sign-out form posts as `csrf`. When the browser has none yet
   * (a cookie lost or cleared), a new one is made and `setCookie` must be sent.
   */
  csrfFor(cookies: Record<string, string>): { token: string; setCookie: string | null };
  /** The `Set-Cookie` that drops the session, for an adapter that saw `getMember` answer `ended`. */
  clearSessionCookie(): string;
  /**
   * kit #10: a GET of `/` carrying the cookie a sign-out left: 303 to the page
   * the sign-out started on (saved-path rule), dropping the cookie. Null for any
   * other request: serve the page as usual.
   */
  signOutReturn(req: RequestView): ResponseView | null;
  /** kit #11: where "Go to my account" opens. Never throws; `<appUrl>/` on any failure. */
  accountUrl(): Promise<string>;
  /** kit #11: the app's page for one course by code, or the learning page. */
  courseUrl(code: string): string;
}

export function createWebsiteKit(input: WebsiteKitConfigInput | WebsiteKitConfig): WebsiteKit {
  const config = resolveConfig(input);
  const names = cookieNames(config.insecureLocalCookies);
  const local = config.insecureLocalCookies;
  const members = createMemberReader(config, names);
  const links = createAccountLinks(config);

  const clearStart = () => clearCookie(names.start, "Lax", local);
  const clearSession = () => clearCookie(names.session, "Lax", local);
  const clearCsrf = () => clearCookie(names.csrf, "Strict", local);
  const clearReturn = () => clearCookie(names.return, "Lax", local);
  // The code routes are made below, once csrfFor and sameOriginRead exist.
  let code: ReturnType<typeof createCodeRoutes>;
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
      // The sign-out value lives as long as the session it signs out (a code-only
      // workspace keeps members 30 days): a shorter one leaves a server-fed page
      // with "My account" and no Sign out.
      serializeCookie(names.csrf, randomToken(43), { sameSite: "Strict", maxAge, expires: expiresAt }, local),
      clearStart(),
    ]);
  }

  /** The kit's one same-site POST rule (same-site.ts), also behind /session/checkout. */
  const sameSiteForm = (req: RequestView): boolean => sameSitePost(req, { origin: config.origin, csrfCookie: names.csrf });

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
    // kit #10: the page to come back to, under the same rule as /session/start.
    // Lax, so it rides the app's top-level navigation back to `<origin>/`.
    const back = savedPath(req.form?.[SIGN_OUT_NEXT_FIELD]);
    const keep =
      back === "/"
        ? clearReturn()
        : serializeCookie(names.return, encodePath(back), { sameSite: "Lax", maxAge: RETURN_COOKIE_MAX_AGE_S }, local);
    // Cleared whatever the API answered: the member is never left signed in on the website.
    return redirect(303, location, [clearSession(), clearCsrf(), ...code.clearCookies(), keep]);
  }

  function csrfFor(cookies: Record<string, string>): { token: string; setCookie: string | null } {
    const existing = cookies[names.csrf];
    if (typeof existing === "string" && CSRF_VALUE.test(existing)) return { token: existing, setCookie: null };
    const token = randomToken(43);
    return { token, setCookie: serializeCookie(names.csrf, token, { sameSite: "Strict", maxAge: CSRF_COOKIE_MAX_AGE_S }, local) };
  }

  /**
   * Same-origin reads only. No CORS header is ever sent, so another site's
   * script cannot read the answer anyway; this also refuses the request
   * before the check is spent on it.
   */
  function sameOriginRead(req: RequestView): boolean {
    const origin = header(req, "origin");
    if (origin !== undefined && origin !== config.origin) return false;
    const site = header(req, "sec-fetch-site");
    return site === undefined || site === "same-origin" || site === "none";
  }

  async function me(req: RequestView): Promise<ResponseView> {
    if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, headers: { ...baseHeaders(), Allow: "GET" }, setCookies: [] };
    if (!sameOriginRead(req)) return { status: 403, headers: baseHeaders(), setCookies: [] };

    const check = await members.getMember(req.cookies);
    const setCookies: string[] = [];
    const answer: SessionMe = { member: null, signOutToken: null, accountUrl: null };
    if (check.status === "ended") {
      setCookies.push(clearSession(), clearCsrf());
    } else if (check.status === "signed-in") {
      const m = check.member;
      answer.member = { ...(m?.firstName ? { firstName: m.firstName } : {}), ...(m?.lastName ? { lastName: m.lastName } : {}) };
      const csrf = csrfFor(req.cookies);
      answer.signOutToken = csrf.token;
      answer.accountUrl = await links.accountUrl();
      if (csrf.setCookie) setCookies.push(csrf.setCookie);
    }
    return {
      status: 200,
      headers: { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8", Vary: "Cookie" },
      setCookies,
      ...(req.method === "GET" ? { body: JSON.stringify(answer) } : {}),
    };
  }

  code = createCodeRoutes({ config, names, csrfFor, sameOriginRead });

  function signOutReturn(req: RequestView): ResponseView | null {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    if (new URL(req.url, config.origin).pathname !== "/") return null;
    const raw = req.cookies[names.return];
    if (raw === undefined) return null;
    const back = decodePath(raw) ?? "/";
    // Back on the page it started from. A bad value goes to `/` once more, without the cookie.
    return redirect(303, back, [clearReturn()]);
  }

  return {
    config,
    cookieNames: names,
    start,
    callback,
    end,
    me,
    codeStep: code.codeStep,
    codeStart: code.codeStart,
    codeResend: code.codeResend,
    codeVerify: code.codeVerify,
    codePay: code.codePay,
    codeRequote: code.codeRequote,
    checkoutContinue: code.checkoutContinue,
    checkoutContinueFor: code.checkoutContinueFor,
    async handle(req) {
      const path = new URL(req.url, config.origin).pathname;
      if (path === SESSION_PATHS.start) return start(req);
      if (path === SESSION_PATHS.callback) return callback(req);
      if (path === SESSION_PATHS.end) return end(req);
      if (path === SESSION_PATHS.me) return me(req);
      if (path === SESSION_PATHS.codeStep) return code.codeStep(req);
      if (path === SESSION_PATHS.codeStart) return code.codeStart(req);
      if (path === SESSION_PATHS.codeResend) return code.codeResend(req);
      if (path === SESSION_PATHS.codeVerify) return code.codeVerify(req);
      if (path === SESSION_PATHS.codePay) return code.codePay(req);
      if (path === SESSION_PATHS.codeRequote) return code.codeRequote(req);
      if (path === SESSION_PATHS.checkoutContinue) return code.checkoutContinue(req);
      return null;
    },
    csrfFor,
    clearSessionCookie: clearSession,
    signOutReturn,
    accountUrl: links.accountUrl,
    courseUrl: links.courseUrl,
    getMember: members.getMember,
    freshMember: members.freshMember,
    remember: members.remember,
    forget: members.forget,
  };
}

export type { MemberCheck };
