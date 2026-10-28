/**
 * Checkout v3.1: the buyer verifies their email by code before payment
 * (spec §4, §6), and the app signs in from that website session (§6.5).
 *
 *   GET  /session/code-step     same-origin read: the form value (`csrf`) for
 *                               the code step, and the open step a reload resumes.
 *   POST /session/code-start    same-site POST + CSRF. `email`, `offer?`, `botToken?`.
 *   POST /session/code-resend   same-site POST + CSRF.
 *   POST /session/code-verify   same-site POST + CSRF. `code`, `firstName?`,
 *                               `lastName?`, `acceptedDocuments?` (JSON).
 *                               Sets the session like /session/callback, and
 *                               `__Host-zw_new=1` only for a new account.
 *   GET  /session/app?to=       303 to the app's claim (appSignIn on, signed in),
 *                               else to the plain app address. Saved-path rule.
 *   GET  /session/app-code      the app's claim asks for a one-time code: 302 to
 *                               `<appUrl>/session/claim/callback?code=&state=`
 *                               or `?error=login_required&state=`.
 *
 * ⛔ `isNewAccount` never reaches the browser: the verify answers only
 * `notice: 'account-ready' | null`, and the flag lives in the HttpOnly cookie.
 * ⛔ The ticket lives only in the HttpOnly ticket cookie; nothing here logs an
 * email, a code, a ticket or a token.
 */
import {
  appCode,
  codeResend,
  codeStart,
  codeVerify,
  isSessionToken,
  reportDropOff,
  type AcceptedDocument,
  type CodeResult,
  type CodeTicket,
  type DropOffStage,
} from "./api-client.ts";
import type { CodeStepRefusal, CodeStepTicket, CodeStepVerified, PendingCodeStep } from "./code-step.ts";
import { UNAVAILABLE_REASON } from "./code-step.ts";
import { ipOf, type WebsiteKitConfig } from "./config.ts";
import { clearCookie, serializeCookie, TICKET_COOKIE_MAX_AGE_S, type CookieNames } from "./cookies.ts";
import type { RequestView, ResponseView } from "./flows.ts";
import type { MemberReader } from "./member.ts";
import { base64url, STATE_PATTERN } from "./pkce.ts";
import { sameSitePost } from "./same-site.ts";
import { savedPath } from "./saved-path.ts";

export const CODE_PATHS = Object.freeze({
  codeStep: "/session/code-step",
  codeStart: "/session/code-start",
  codeResend: "/session/code-resend",
  codeVerify: "/session/code-verify",
  app: "/session/app",
  appCode: "/session/app-code",
});

/** The site's link to the app: through `/session/app`, which picks the claim or the plain address. */
export function appLinkHref(to: unknown): string {
  return `${CODE_PATHS.app}?to=${encodeURIComponent(savedPath(to))}`;
}

/** What GET /session/code-step answers. */
export interface CodeStepRead {
  /** The value the code step's POSTs send as `csrf`. */
  formToken: string;
  /** The open step from the ticket cookie, or null. */
  pending: PendingCodeStep | null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const DIGITS = /^\d{1,12}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const BOT_TOKEN_MAX = 4096;
const NAME_MAX = 60;
const DOCS_MAX = 10;
const DOC_VALUE_MAX = 64;

interface TicketCookie {
  t: string;
  e: string;
  o?: string;
  l: number;
  x: number;
  r: string;
}

const baseHeaders = (): Record<string, string> => ({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });

function json(status: number, body: unknown, setCookies: string[] = []): ResponseView {
  return { status, headers: { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8" }, setCookies, body: JSON.stringify(body) };
}

const methodNotAllowed = (allow: string): ResponseView => ({ status: 405, headers: { ...baseHeaders(), Allow: allow }, setCookies: [] });
const forbidden = (): ResponseView => ({ status: 403, headers: baseHeaders(), setCookies: [] });
const redirect = (status: 302 | 303, location: string): ResponseView => ({ status, headers: { ...baseHeaders(), Location: location }, setCookies: [] });

function encodeTicket(value: TicketCookie): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeTicket(raw: string | undefined, now: number): TicketCookie | null {
  if (!raw || !/^[A-Za-z0-9_-]{1,2048}$/.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((raw.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Partial<TicketCookie>;
    if (typeof v.t !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.t)) return null;
    if (typeof v.e !== "string" || !EMAIL.test(v.e)) return null;
    if (typeof v.l !== "number" || typeof v.x !== "number" || typeof v.r !== "string" || Number.isNaN(Date.parse(v.r))) return null;
    if (v.x <= now) return null;
    return { t: v.t, e: v.e, l: v.l, x: v.x, r: v.r, ...(typeof v.o === "string" && OBJECT_ID.test(v.o) ? { o: v.o } : {}) };
  } catch {
    return null;
  }
}

function nameField(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  // eslint-disable-next-line no-control-regex
  return v !== "" && v.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined;
}

/**
 * `acceptedDocuments` as the form's JSON: at most 10 items of `{type, version}`,
 * each 1-64 characters (the gateway refuses anything else with
 * `invalid_request`). A number version is sent as its string; an item without
 * both is dropped.
 */
function documentsOf(value: string | undefined): AcceptedDocument[] | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const out: AcceptedDocument[] = [];
  for (const item of parsed.slice(0, DOCS_MAX)) {
    if (!item || typeof item !== "object") continue;
    const { type, version: rawVersion } = item as Record<string, unknown>;
    const version = typeof rawVersion === "number" && Number.isFinite(rawVersion) ? String(rawVersion) : rawVersion;
    const fieldOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= DOC_VALUE_MAX;
    if (fieldOk(type) && fieldOk(version)) out.push({ type, version });
  }
  return out.length > 0 ? out : undefined;
}

/** A failed code call as the browser sees it: the reason only, never the API's sentence or body. */
function refusalOf(res: CodeResult<unknown> & { ok: false }): { status: number; body: CodeStepRefusal } {
  if (res.error === "refused" && res.reason) {
    // The gateway's own code: 429 (locked, rate limited), 503 (BOT_CHECK_UNAVAILABLE), else 400.
    const status = res.status === 429 || res.status === 503 ? res.status : 400;
    return {
      status,
      body: {
        reason: res.reason,
        ...(res.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: res.retryAfterSeconds }),
        ...(res.fields ? { fields: res.fields } : {}),
      },
    };
  }
  if (res.error === "rate_limited") return { status: 429, body: { reason: "WEBSITE_CODE_RATE_LIMITED" } };
  return { status: 503, body: { reason: UNAVAILABLE_REASON } };
}

export interface CodeRoutesDeps {
  config: WebsiteKitConfig;
  names: CookieNames;
  members: MemberReader;
  csrfFor(cookies: Record<string, string>): { token: string; setCookie: string | null };
  /** True when the request is a same-origin read (as /session/me checks). */
  sameOriginRead(req: RequestView): boolean;
}

export interface CodeRoutes {
  codeStep(req: RequestView): Promise<ResponseView>;
  codeStart(req: RequestView): Promise<ResponseView>;
  codeResend(req: RequestView): Promise<ResponseView>;
  codeVerify(req: RequestView): Promise<ResponseView>;
  app(req: RequestView): Promise<ResponseView>;
  appCode(req: RequestView): Promise<ResponseView>;
  /** True when the browser's session was made by a code verify that created or completed the account. */
  isNewAccountBuyer(cookies: Record<string, string>): boolean;
  /** The `Set-Cookie` values that drop the code step's cookies (sign-out). */
  clearCookies(): string[];
}

export function createCodeRoutes(deps: CodeRoutesDeps): CodeRoutes {
  const { config, names, members } = deps;
  const local = config.insecureLocalCookies;
  const clearTicket = () => clearCookie(names.ticket, "Lax", local);
  const clearNew = () => clearCookie(names.newAccount, "Lax", local);
  const sameSiteForm = (req: RequestView) => sameSitePost(req, { origin: config.origin, csrfCookie: names.csrf });

  function buyerIpOf(req: RequestView): string | null {
    const lower: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) lower[k.toLowerCase()] = v;
    let ip: string | null = null;
    try {
      ip = ipOf(config.buyerIpFrom(lower));
    } catch {
      ip = null;
    }
    // Local development has no proxy in front: the buyer is this machine.
    return ip ?? (local ? "127.0.0.1" : null);
  }

  function dropOff(email: string, offer: string | undefined, stage: DropOffStage): void {
    if (!offer) return;
    // Fire-and-forget: never awaited, never blocks the step, never throws.
    void reportDropOff(config, { email, offer, stage }).catch(() => undefined);
  }

  function ticketCookie(ticket: CodeTicket, email: string, offer: string | undefined): string {
    const now = config.now();
    const value: TicketCookie = { t: ticket.ticketId, e: email, l: ticket.codeLength, x: now + ticket.codeExpiresInSeconds * 1000, r: ticket.resendAvailableAt, ...(offer ? { o: offer } : {}) };
    return serializeCookie(names.ticket, encodeTicket(value), { sameSite: "Lax", maxAge: TICKET_COOKIE_MAX_AGE_S }, local);
  }

  const browserTicket = (t: CodeTicket): CodeStepTicket => ({ codeLength: t.codeLength, codeExpiresInSeconds: t.codeExpiresInSeconds, resendAvailableAt: t.resendAvailableAt });

  async function codeStep(req: RequestView): Promise<ResponseView> {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed("GET");
    if (!deps.sameOriginRead(req)) return forbidden();
    const csrf = deps.csrfFor(req.cookies);
    const t = decodeTicket(req.cookies[names.ticket], config.now());
    const answer: CodeStepRead = {
      formToken: csrf.token,
      pending: t ? { email: t.e, codeLength: t.l, codeExpiresAt: new Date(t.x).toISOString(), resendAvailableAt: t.r } : null,
    };
    const view = json(200, answer, csrf.setCookie ? [csrf.setCookie] : []);
    view.headers.Vary = "Cookie";
    if (req.method === "HEAD") delete view.body;
    return view;
  }

  async function startRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const form = req.form ?? {};
    const email = typeof form.email === "string" ? form.email.trim().toLowerCase() : "";
    if (email.length > 254 || !EMAIL.test(email)) return json(400, { reason: "WEBSITE_CODE_EMAIL_INVALID" } satisfies CodeStepRefusal);
    const offer = typeof form.offer === "string" && OBJECT_ID.test(form.offer) ? form.offer : undefined;
    const botToken = typeof form.botToken === "string" && form.botToken !== "" && form.botToken.length <= BOT_TOKEN_MAX ? form.botToken : undefined;
    const buyerIp = buyerIpOf(req);
    if (!buyerIp) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal);

    const res = await codeStart(config, { email, buyerIp, ...(botToken ? { botToken } : {}) });
    if (!res.ok) {
      const r = refusalOf(res);
      return json(r.status, r.body);
    }
    dropOff(email, offer, "code_sent");
    return json(200, browserTicket(res.body), [ticketCookie(res.body, email, offer)]);
  }

  async function resendRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const t = decodeTicket(req.cookies[names.ticket], config.now());
    if (!t) return json(400, { reason: "WEBSITE_CODE_EXPIRED" } satisfies CodeStepRefusal, [clearTicket()]);
    const buyerIp = buyerIpOf(req);
    if (!buyerIp) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal);

    const res = await codeResend(config, { ticketId: t.t, buyerIp });
    if (!res.ok) {
      const r = refusalOf(res);
      return json(r.status, r.body);
    }
    return json(200, browserTicket(res.body), [ticketCookie(res.body, t.e, t.o)]);
  }

  async function verifyRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const t = decodeTicket(req.cookies[names.ticket], config.now());
    if (!t) return json(400, { reason: "WEBSITE_CODE_EXPIRED" } satisfies CodeStepRefusal, [clearTicket()]);
    const form = req.form ?? {};
    const code = typeof form.code === "string" ? form.code.replace(/\s+/g, "") : "";
    // Not digits at all: the code's shape is wrong, so it isn't right (no guess is spent).
    if (!DIGITS.test(code)) return json(400, { reason: "WEBSITE_CODE_INVALID" } satisfies CodeStepRefusal);
    const buyerIp = buyerIpOf(req);
    if (!buyerIp) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal);

    const firstName = nameField(form.firstName);
    const lastName = nameField(form.lastName);
    const acceptedDocuments = documentsOf(form.acceptedDocuments);
    // ONE verify per submit, never retried: a code works once.
    const res = await codeVerify(config, {
      ticketId: t.t,
      code,
      buyerIp,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(acceptedDocuments ? { acceptedDocuments } : {}),
    });
    if (!res.ok) {
      const r = refusalOf(res);
      return json(r.status, r.body);
    }

    const now = config.now();
    const expiresAt = new Date(res.body.expiresAt);
    const maxAge = Math.floor((expiresAt.getTime() - now) / 1000);
    if (maxAge <= 0) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal, [clearTicket()]);

    // Signed in now: a fresh check reads the member (the verify answer carries no id to cache).
    await members.forget(res.body.sessionToken);
    // The form value stays the one the page already holds, now living as long as the session.
    const csrf = deps.csrfFor(req.cookies).token;
    const lifetime = { sameSite: "Lax" as const, maxAge, expires: expiresAt };
    const setCookies = [
      serializeCookie(names.session, res.body.sessionToken, lifetime, local),
      serializeCookie(names.csrf, csrf, { ...lifetime, sameSite: "Strict" }, local),
      res.body.isNewAccount ? serializeCookie(names.newAccount, "1", lifetime, local) : clearNew(),
      clearTicket(),
    ];
    dropOff(t.e, t.o, "verified");
    const m = res.body.member;
    const answer: CodeStepVerified = {
      member: { ...(m.firstName ? { firstName: m.firstName } : {}), ...(m.lastName ? { lastName: m.lastName } : {}) },
      // Display only: the flag itself stays on the server (HttpOnly cookie).
      notice: res.body.isNewAccount ? "account-ready" : null,
      signOutToken: csrf,
    };
    return json(200, answer, setCookies);
  }

  async function app(req: RequestView): Promise<ResponseView> {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed("GET");
    const to = savedPath(new URL(req.url, config.origin).searchParams.get("to"));
    if (!config.appSignIn || !isSessionToken(req.cookies[names.session])) return redirect(303, `${config.appUrl}${to}`);
    const target = new URL(`${config.appUrl}/session/claim`);
    target.searchParams.set("return_origin", config.origin);
    target.searchParams.set("to", to);
    return redirect(303, target.href);
  }

  async function appCodeRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed("GET");
    const params = new URL(req.url, config.origin).searchParams;
    const state = params.get("state");
    if (state === null || !STATE_PATTERN.test(state)) return { status: 400, headers: baseHeaders(), setCookies: [] };
    const back = (extra: Record<string, string>) => {
      const target = new URL(`${config.appUrl}/session/claim/callback`);
      for (const [k, v] of Object.entries(extra)) target.searchParams.set(k, v);
      target.searchParams.set("state", state);
      return redirect(302, target.href);
    };
    const loginRequired = () => back({ error: "login_required" });

    const challenge = params.get("code_challenge");
    const token = req.cookies[names.session];
    if (!config.appSignIn || challenge === null || !CHALLENGE.test(challenge) || !isSessionToken(token)) return loginRequired();
    if (req.method === "HEAD") return loginRequired();

    const res = await appCode(config, { sessionToken: token, codeChallenge: challenge });
    return res.ok ? back({ code: res.body.code }) : loginRequired();
  }

  return {
    codeStep,
    codeStart: startRoute,
    codeResend: resendRoute,
    codeVerify: verifyRoute,
    app,
    appCode: appCodeRoute,
    isNewAccountBuyer(cookies) {
      return cookies[names.newAccount] === "1" && isSessionToken(cookies[names.session]);
    },
    clearCookies: () => [clearNew(), clearTicket()],
  };
}

