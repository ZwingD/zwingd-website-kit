/**
 * The three server-to-server calls (session hand-over v1): exchange, session
 * and end, `POST <ZWINGD_API_URL>/api/external/session-handover/<call>` with the
 * client secret in `Authorization` only.
 *
 * Never throws. Each call answers `{ ok: true, body }` or `{ ok: false, error }`
 * where `error` is the contract's one word, `timeout` (treat as `unavailable`)
 * or `network`. Nothing here ever puts the secret, a token, a code or the
 * verifier into an error, and the API's own body is never echoed beyond its
 * known fields.
 */
import type { WebsiteKitConfig } from "./config.ts";

export const HANDOVER_ERRORS = ["invalid_request", "invalid_client", "invalid_grant", "rate_limited", "unavailable"] as const;
export type HandoverError = (typeof HANDOVER_ERRORS)[number];
export type CallFailure = HandoverError | "timeout" | "network";

export type CallResult<T> = { ok: true; body: T } | { ok: false; error: CallFailure; status?: number };

export interface HandoverMember {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  mobile?: string;
  mobileCountry?: string;
}

export interface ExchangeBody {
  sessionToken: string;
  expiresAt: string;
  member: HandoverMember;
}

export type SessionBody = { active: true; expiresAt: string; member: HandoverMember } | { active: false };

export interface EndBody {
  ended: true;
  appSignOutUrl: string | null;
  signOutTicket?: string;
}

const TOKEN = /^[0-9a-f]{64}$/;
const MEMBER_FIELDS = ["firstName", "lastName", "email", "mobile", "mobileCountry"] as const;

function member(value: unknown): HandoverMember | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  const out: HandoverMember = { id: raw.id };
  for (const key of MEMBER_FIELDS) if (typeof raw[key] === "string") out[key] = raw[key] as string;
  return out;
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function errorWord(status: number, body: unknown): HandoverError {
  const word = (body as { error?: unknown } | null)?.error;
  if (typeof word === "string" && (HANDOVER_ERRORS as readonly string[]).includes(word)) return word as HandoverError;
  if (status === 429) return "rate_limited";
  if (status === 401) return "invalid_client";
  if (status >= 500) return "unavailable";
  return "invalid_request";
}

/** A failed call's own answer, kept for the member checkout calls, whose two extra causes the v1 words do not cover. */
type PostResult = CallResult<unknown> & { raw?: unknown };

async function post(
  config: WebsiteKitConfig,
  call: string,
  body: Record<string, unknown>,
  timeoutMs: number = config.timeoutMs
): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await config.fetch(`${config.apiUrl}/api/external/session-handover/${call}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.clientSecret}` },
      body: JSON.stringify({ realm: config.realm, origin: config.origin, ...body }),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (!res.ok) return { ok: false, error: errorWord(res.status, parsed), status: res.status, raw: parsed };
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, error: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** Exchange a code for a website session. Call it ONCE per code: a second presentation ends the session the first created. */
export async function exchangeCode(config: WebsiteKitConfig, code: string, codeVerifier: string): Promise<CallResult<ExchangeBody>> {
  const res = await post(config, "exchange", { code, codeVerifier });
  if (!res.ok) return failureOf(res);
  const raw = res.body as Record<string, unknown> | null;
  const m = member(raw?.member);
  if (!raw || typeof raw.sessionToken !== "string" || !TOKEN.test(raw.sessionToken) || !isTime(raw.expiresAt) || !m) {
    return { ok: false, error: "unavailable" };
  }
  return { ok: true, body: { sessionToken: raw.sessionToken, expiresAt: raw.expiresAt, member: m } };
}

/** Check a website session; `active: false` means drop it. */
export async function checkSession(config: WebsiteKitConfig, sessionToken: string): Promise<CallResult<SessionBody>> {
  const res = await post(config, "session", { sessionToken });
  if (!res.ok) return failureOf(res);
  const raw = res.body as Record<string, unknown> | null;
  if (raw?.active === false) return { ok: true, body: { active: false } };
  const m = member(raw?.member);
  if (raw?.active !== true || !isTime(raw.expiresAt) || !m) return { ok: false, error: "unavailable" };
  return { ok: true, body: { active: true, expiresAt: raw.expiresAt, member: m } };
}

/** End a website session; safe to repeat. */
export async function endSession(config: WebsiteKitConfig, sessionToken: string): Promise<CallResult<EndBody>> {
  const res = await post(config, "end", { sessionToken });
  if (!res.ok) return failureOf(res);
  const raw = res.body as Record<string, unknown> | null;
  const url = typeof raw?.appSignOutUrl === "string" ? raw.appSignOutUrl : null;
  return { ok: true, body: { ended: true, appSignOutUrl: url, ...(typeof raw?.signOutTicket === "string" ? { signOutTicket: raw.signOutTicket } : {}) } };
}

/** A failure as a v1 call answers it: the API's own answer is never passed on. */
function failureOf(res: PostResult & { ok: false }): CallResult<never> {
  return { ok: false, error: res.error, ...(res.status === undefined ? {} : { status: res.status }) };
}

// ---------------------------------------------------------------------------
// Member checkout (session hand-over v1.1, "Member checkout"; contract C4)
// ---------------------------------------------------------------------------

/** The contract's timeouts: 10 s for a quote, 30 s for a start. */
export const CHECKOUT_QUOTE_TIMEOUT_MS = 10_000;
export const CHECKOUT_START_TIMEOUT_MS = 30_000;

/**
 * Why a member checkout call failed: a v1 word, `timeout` / `network`, or one
 * of the routes' own causes: `login_required` (the session is over),
 * `checkout_refused` (with the API's `reason`) and `not_available` (404: an API
 * without member checkout).
 */
export type CheckoutFailure = CallFailure | "login_required" | "checkout_refused" | "not_available";
export type CheckoutResult<T> = { ok: true; body: T } | { ok: false; error: CheckoutFailure; reason?: string };

/** C2's quote: what the member would pay for one offer now. */
export interface MemberQuote {
  offer: string;
  currencyCode: string;
  minorUnitExponent: number;
  totalMinor: string;
  subTotalMinor: string;
  discountTotalMinor: string;
  taxTotalMinor: string;
  pricesIncludeTax: boolean;
  alreadyEnrolled: boolean;
  gateways: Array<{ paymentGateway: string; name: string | null }>;
}

/** C3's session: the member's order and where to send the browser. */
export interface MemberCheckoutSession {
  orderId: string;
  paymentState: string;
  /** Null when the order settled at once (a zero total). */
  redirectUrl: string | null;
  resumed: boolean;
  orderToken: string | null;
  orderTokenExpiresAt: string | null;
}

export interface MemberQuoteInput {
  offer: string;
  couponCode?: string;
  visitorCountry?: string;
}

export interface MemberStartInput extends MemberQuoteInput {
  paymentGateway?: string;
  expectedTotalMinor: string;
  returnUrl: string;
  attribution?: Record<string, string>;
}

const OBJECT_ID = /^[0-9a-f]{24}$/;
const MINOR = /^-?\d{1,18}$/;
const REASON = /^[A-Z][A-Z0-9_]*$/;
const isMinor = (value: unknown): value is string => typeof value === "string" && MINOR.test(value);

function memberQuote(raw: unknown): MemberQuote | null {
  const q = raw as Record<string, unknown> | null;
  if (!q || typeof q !== "object") return null;
  if (typeof q.offer !== "string" || typeof q.currencyCode !== "string" || typeof q.minorUnitExponent !== "number") return null;
  if (![q.totalMinor, q.subTotalMinor, q.discountTotalMinor, q.taxTotalMinor].every(isMinor)) return null;
  if (typeof q.pricesIncludeTax !== "boolean" || typeof q.alreadyEnrolled !== "boolean" || !Array.isArray(q.gateways)) return null;
  const gateways: MemberQuote["gateways"] = [];
  for (const g of q.gateways as Array<Record<string, unknown>>) {
    if (!g || typeof g.paymentGateway !== "string" || !OBJECT_ID.test(g.paymentGateway)) return null;
    gateways.push({ paymentGateway: g.paymentGateway, name: typeof g.name === "string" ? g.name : null });
  }
  return {
    offer: q.offer,
    currencyCode: q.currencyCode,
    minorUnitExponent: q.minorUnitExponent,
    totalMinor: q.totalMinor as string,
    subTotalMinor: q.subTotalMinor as string,
    discountTotalMinor: q.discountTotalMinor as string,
    taxTotalMinor: q.taxTotalMinor as string,
    pricesIncludeTax: q.pricesIncludeTax,
    alreadyEnrolled: q.alreadyEnrolled,
    gateways,
  };
}

function checkoutSession(raw: unknown): MemberCheckoutSession | null {
  const s = raw as Record<string, unknown> | null;
  if (!s || typeof s !== "object" || typeof s.orderId !== "string" || !OBJECT_ID.test(s.orderId)) return null;
  if (typeof s.paymentState !== "string" || typeof s.resumed !== "boolean") return null;
  const redirect = s.redirectUrl;
  if (redirect !== null && (typeof redirect !== "string" || !/^https?:\/\//.test(redirect))) return null;
  const token = typeof s.orderToken === "string" && s.orderToken !== "" ? s.orderToken : null;
  const expires = typeof s.orderTokenExpiresAt === "string" && isTime(s.orderTokenExpiresAt) ? s.orderTokenExpiresAt : null;
  return { orderId: s.orderId, paymentState: s.paymentState, redirectUrl: redirect, resumed: s.resumed, orderToken: token, orderTokenExpiresAt: expires };
}

/** A failed member checkout call: the routes' own causes first, else the v1 word. Nothing else of the answer is kept. */
function checkoutFailure(res: PostResult & { ok: false }): CheckoutResult<never> {
  const raw = res.raw as { error?: unknown; reason?: unknown } | null | undefined;
  if (res.status === 404) return { ok: false, error: "not_available" };
  if (raw?.error === "login_required") return { ok: false, error: "login_required" };
  if (raw?.error === "checkout_refused") {
    return { ok: false, error: "checkout_refused", ...(typeof raw.reason === "string" && REASON.test(raw.reason) ? { reason: raw.reason } : {}) };
  }
  return { ok: false, error: res.error };
}

/** C4 `checkout/quote`. Never throws. */
export async function checkoutQuote(
  config: WebsiteKitConfig,
  sessionToken: string,
  input: MemberQuoteInput,
  timeoutMs: number = CHECKOUT_QUOTE_TIMEOUT_MS
): Promise<CheckoutResult<MemberQuote>> {
  const res = await post(config, "checkout/quote", { sessionToken, ...input }, timeoutMs);
  if (!res.ok) return checkoutFailure(res);
  const quote = memberQuote(res.body);
  return quote ? { ok: true, body: quote } : { ok: false, error: "unavailable" };
}

/**
 * C4 `checkout/start`. Never throws, and is NEVER retried here: a start creates
 * a payment. A second start for the same offer answers the open order.
 */
export async function checkoutStart(
  config: WebsiteKitConfig,
  sessionToken: string,
  input: MemberStartInput,
  timeoutMs: number = CHECKOUT_START_TIMEOUT_MS
): Promise<CheckoutResult<MemberCheckoutSession>> {
  const res = await post(config, "checkout/start", { sessionToken, ...input }, timeoutMs);
  if (!res.ok) return checkoutFailure(res);
  const session = checkoutSession(res.body);
  return session ? { ok: true, body: session } : { ok: false, error: "unavailable" };
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}
