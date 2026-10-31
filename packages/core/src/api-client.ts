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
  /**
   * The currency of `expectedTotalMinor` (ISO 4217, Helm #14 on #1963): a start whose charged currency differs is
   * refused PRICE_CHANGED, as a changed total is (A2). An API older than that ignores the key (the gateway picks
   * the fields it knows), so the total alone is compared, as before.
   */
  expectedCurrencyCode?: string;
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

/**
 * Who a checkout call is for: a member's website session (the token string),
 * or, v0.2.0 (checkout v3.2 §5, A1), a verified buyer's proof with the buyer's
 * IP. The API takes exactly one of `sessionToken` or `checkoutProof`.
 */
export type CheckoutBuyer = string | { checkoutProof: string; buyerIp: string };

function buyerFields(buyer: CheckoutBuyer): Record<string, string> {
  return typeof buyer === "string" ? { sessionToken: buyer } : { checkoutProof: buyer.checkoutProof, buyerIp: buyer.buyerIp };
}

/** C4 `checkout/quote`. Never throws. */
export async function checkoutQuote(
  config: WebsiteKitConfig,
  buyer: CheckoutBuyer,
  input: MemberQuoteInput,
  timeoutMs: number = CHECKOUT_QUOTE_TIMEOUT_MS
): Promise<CheckoutResult<MemberQuote>> {
  const res = await post(config, "checkout/quote", { ...buyerFields(buyer), ...input }, timeoutMs);
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
  buyer: CheckoutBuyer,
  input: MemberStartInput,
  timeoutMs: number = CHECKOUT_START_TIMEOUT_MS
): Promise<CheckoutResult<MemberCheckoutSession>> {
  const res = await post(config, "checkout/start", { ...buyerFields(buyer), ...input }, timeoutMs);
  if (!res.ok) return checkoutFailure(res);
  const session = checkoutSession(res.body);
  return session ? { ok: true, body: session } : { ok: false, error: "unavailable" };
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

// ---------------------------------------------------------------------------
// Website email verification (checkout v3.2, spec §4) and the proof (§4.3, §6, A3)
// ---------------------------------------------------------------------------

/**
 * The API refusal reasons for the code, proof and proof-carrying checkout calls (spec §4, §5, §10b B1; contract
 * "Refusal reasons"). The kit's own reasons (INVALID_REQUEST, UNAVAILABLE, STORAGE_UNAVAILABLE) are not in it.
 */
export const CODE_REASONS = [
  "WEBSITE_CODE_DISABLED",
  "WEBSITE_CODE_EMAIL_INVALID",
  "WEBSITE_CODE_INVALID",
  "WEBSITE_CODE_EXPIRED",
  "WEBSITE_CODE_LOCKED",
  "WEBSITE_CODE_RATE_LIMITED",
  "WEBSITE_TERMS_REQUIRED",
  "BOT_CHECK_FAILED",
  "BOT_CHECK_UNAVAILABLE",
  "CHECKOUT_PROOF_INVALID",
  "CHECKOUT_PROOF_EMAIL_MISMATCH",
  "CHECKOUT_PROOF_UNAVAILABLE",
  "EMAIL_VERIFICATION_REQUIRED",
] as const;
export type CodeReason = (typeof CODE_REASONS)[number];

/** The code calls' timeout: the contract's 10 s. */
export const CODE_CALL_TIMEOUT_MS = 10_000;

/** A code call's refusal: the API's `reason` when it has the standard shape, else a v1 word. */
export type CodeResult<T> =
  | { ok: true; body: T }
  | { ok: false; error: "refused"; reason: string; retryAfterSeconds?: number; fields?: string[]; status?: number }
  | { ok: false; error: CallFailure | "login_required"; status?: number };

export interface CodeTicket {
  ticketId: string;
  codeLength: number;
  codeExpiresInSeconds: number;
  resendAvailableAt: string;
}

/**
 * What `code/verify` answers (§4.3): the verified-email proof and its life.
 * No account, no session, nothing about membership. For the website's SERVER
 * only: the proof never reaches page JavaScript or an address.
 */
export interface CodeVerified {
  proof: string;
  proofExpiresInSeconds: number;
}

/** A legal document the step showed, as the gateway reads it: both fields 1-64 characters. */
export interface AcceptedDocument {
  type: string;
  version: string;
}

export interface CodeVerifyInput {
  ticketId: string;
  code: string;
  buyerIp: string;
  firstName?: string;
  lastName?: string;
  acceptedDocuments?: AcceptedDocument[];
}

const TICKET = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

function codeFailure(res: PostResult & { ok: false }): CodeResult<never> {
  const raw = res.raw as { error?: unknown; reason?: unknown; retryAfterSeconds?: unknown; fields?: unknown } | null | undefined;
  if (raw?.error === "login_required") return { ok: false, error: "login_required" };
  if (typeof raw?.reason === "string" && REASON.test(raw.reason)) {
    const retry = typeof raw.retryAfterSeconds === "number" && Number.isFinite(raw.retryAfterSeconds) && raw.retryAfterSeconds >= 0 ? Math.ceil(raw.retryAfterSeconds) : undefined;
    const fields = Array.isArray(raw.fields) ? raw.fields.filter((f): f is string => typeof f === "string" && FIELD.test(f)).slice(0, 20) : undefined;
    return {
      ok: false,
      error: "refused",
      reason: raw.reason,
      ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
      ...(fields && fields.length > 0 ? { fields } : {}),
      ...(res.status === undefined ? {} : { status: res.status }),
    };
  }
  return { ok: false, error: res.error, ...(res.status === undefined ? {} : { status: res.status }) };
}

function codeTicket(raw: unknown): CodeTicket | null {
  const t = raw as Record<string, unknown> | null;
  if (!t || typeof t !== "object" || typeof t.ticketId !== "string" || !TICKET.test(t.ticketId)) return null;
  if (typeof t.codeLength !== "number" || !Number.isInteger(t.codeLength) || t.codeLength < 4 || t.codeLength > 12) return null;
  if (typeof t.codeExpiresInSeconds !== "number" || !(t.codeExpiresInSeconds > 0)) return null;
  if (!isTime(t.resendAvailableAt)) return null;
  return { ticketId: t.ticketId, codeLength: t.codeLength, codeExpiresInSeconds: Math.floor(t.codeExpiresInSeconds), resendAvailableAt: t.resendAvailableAt };
}

/** Spec 4.1 `code/start`. Never throws; never retried. */
export async function codeStart(
  config: WebsiteKitConfig,
  input: { email: string; buyerIp: string; botToken?: string },
  timeoutMs: number = CODE_CALL_TIMEOUT_MS
): Promise<CodeResult<CodeTicket>> {
  const res = await post(config, "code/start", { email: input.email, buyerIp: input.buyerIp, ...(input.botToken ? { botToken: input.botToken } : {}) }, timeoutMs);
  if (!res.ok) return codeFailure(res);
  const ticket = codeTicket(res.body);
  return ticket ? { ok: true, body: ticket } : { ok: false, error: "unavailable" };
}

/** Spec 4.2 `code/resend`. Never throws. */
export async function codeResend(
  config: WebsiteKitConfig,
  input: { ticketId: string; buyerIp: string },
  timeoutMs: number = CODE_CALL_TIMEOUT_MS
): Promise<CodeResult<CodeTicket>> {
  const res = await post(config, "code/resend", { ticketId: input.ticketId, buyerIp: input.buyerIp }, timeoutMs);
  if (!res.ok) return codeFailure(res);
  const ticket = codeTicket(res.body);
  return ticket ? { ok: true, body: ticket } : { ok: false, error: "unavailable" };
}

/** The proof is opaque (at least 32 random bytes); the kit only checks it is cookie-safe. */
export const PROOF_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const NONCE = /^[A-Za-z0-9_-]{16,512}$/;
const lifeOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

/** Spec 4.3 `code/verify`. Never throws, and never retried: a code works once. */
export async function codeVerify(config: WebsiteKitConfig, input: CodeVerifyInput, timeoutMs: number = CODE_CALL_TIMEOUT_MS): Promise<CodeResult<CodeVerified>> {
  const res = await post(config, "code/verify", { ...input }, timeoutMs);
  if (!res.ok) return codeFailure(res);
  const raw = res.body as Record<string, unknown> | null;
  const life = lifeOf(raw?.proofExpiresInSeconds);
  if (!raw || typeof raw.proof !== "string" || !PROOF_PATTERN.test(raw.proof) || life === null) return { ok: false, error: "unavailable" };
  // Only these two fields: anything else the API might add is never passed on.
  return { ok: true, body: { proof: raw.proof, proofExpiresInSeconds: life } };
}

/** Which thank-you button: a new buyer (or a pending learner) finishes sign-up; a member goes to the course. */
export type ContinueAs = "sign-up" | "member";

/**
 * Contract `checkout-proof/context`: server-side only; does not use the proof up. Never throws. It names no order:
 * which order the button belongs to is the kit's own check (Helm #26 on #1963, option a).
 */
export async function proofContext(
  config: WebsiteKitConfig,
  input: { proof: string },
  timeoutMs: number = CODE_CALL_TIMEOUT_MS
): Promise<CodeResult<{ continueAs: ContinueAs; proofExpiresInSeconds: number }>> {
  const res = await post(config, "checkout-proof/context", { proof: input.proof }, timeoutMs);
  if (!res.ok) return codeFailure(res);
  const raw = res.body as Record<string, unknown> | null;
  const continueAs = raw?.continueAs;
  const life = lifeOf(raw?.proofExpiresInSeconds);
  if ((continueAs !== "sign-up" && continueAs !== "member") || life === null) return { ok: false, error: "unavailable" };
  return { ok: true, body: { continueAs, proofExpiresInSeconds: life } };
}

/**
 * The app's continue route (A3, A4): an https address whose path is exactly `/session/checkout-continue`. The host
 * is the API's choice (A4: the canonical app domain or a verified custom domain); the kit does not check it.
 */
export const APP_CONTINUE_PATH = "/session/checkout-continue";

function continueUrlOf(value: unknown, local: boolean): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const schemeOk = url.protocol === "https:" || (local && url.protocol === "http:");
  if (!schemeOk || url.username || url.password || url.search || url.hash || url.pathname !== APP_CONTINUE_PATH) return null;
  return url.href;
}

/**
 * Contract `checkout-proof/continue` (A3): a 60 s single-use nonce for the
 * app's continue route, minted when the buyer presses the thank-you button,
 * never on a page load. Does not use the proof up. Never throws.
 */
export async function proofContinue(
  config: WebsiteKitConfig,
  input: { proof: string },
  timeoutMs: number = CODE_CALL_TIMEOUT_MS
): Promise<CodeResult<{ nonce: string; nonceExpiresInSeconds: number; continueUrl: string }>> {
  const res = await post(config, "checkout-proof/continue", { proof: input.proof }, timeoutMs);
  if (!res.ok) return codeFailure(res);
  const raw = res.body as Record<string, unknown> | null;
  const continueUrl = continueUrlOf(raw?.continueUrl, config.insecureLocalCookies);
  const life = lifeOf(raw?.nonceExpiresInSeconds);
  if (!raw || typeof raw.nonce !== "string" || !NONCE.test(raw.nonce) || !continueUrl || life === null) return { ok: false, error: "unavailable" };
  return { ok: true, body: { nonce: raw.nonce, nonceExpiresInSeconds: life, continueUrl } };
}

/**
 * The site reports "code sent" only: identity records "verified" itself when
 * a verify succeeds (v3.2 B5).
 */
export type DropOffStage = "code_sent";

/**
 * Spec §5 drop-off, the site's "code sent" leg. The caller awaits it (code-routes caps it at 2 s). The answer is
 * ignored and it never throws (post() catches every fault), so a failed report never fails the start.
 */
export async function reportDropOff(
  config: WebsiteKitConfig,
  input: { email: string; offer: string; stage: DropOffStage },
  timeoutMs: number = CODE_CALL_TIMEOUT_MS
): Promise<void> {
  await post(config, "checkout/drop-off", { email: input.email, offer: input.offer, stage: input.stage }, timeoutMs);
}

// ---------------------------------------------------------------------------
// Member events (B2 + B4): `events/read` and `events/register`
// ---------------------------------------------------------------------------

/**
 * Why a member event call failed: `ended` (the session is over), `refused`
 * (with the gateway's `reason` and, for a registration, the `fields` it
 * names), `not_available` (404 with no contract body: an API without member
 * events) or `unavailable` (busy, down, rate limited, a timeout, a malformed
 * answer). Nothing else of the answer is kept.
 */
export type EventCallFailure = "ended" | "refused" | "not_available" | "unavailable";
export type EventCallResult<T> = { ok: true; body: T } | { ok: false; error: EventCallFailure; reason?: string; fields?: string[] };

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/**
 * The gateway answers `{ status: 'ok' | 'ended' | 'refused' | 'unavailable', ... }`.
 * A known `status` is read whatever the HTTP code; without one, the checkout
 * routes' error words are read the same way (`login_required` is ended, a 404 is
 * not-available, anything else unavailable).
 */
function eventCall(res: PostResult): EventCallResult<Record<string, unknown>> {
  const raw = (res.ok ? res.body : res.raw) as Record<string, unknown> | null | undefined;
  const status = raw && typeof raw === "object" ? raw.status : undefined;
  if (status === "ok") return res.ok ? { ok: true, body: raw as Record<string, unknown> } : { ok: false, error: "unavailable" };
  if (status === "ended") return { ok: false, error: "ended" };
  if (status === "refused") {
    const reason = typeof raw!.reason === "string" && REASON.test(raw!.reason) ? raw!.reason : undefined;
    const fields = Array.isArray(raw!.fields) ? raw!.fields.filter((f): f is string => typeof f === "string" && FIELD_KEY.test(f)) : undefined;
    return { ok: false, error: "refused", ...(reason ? { reason } : {}), ...(fields && fields.length > 0 ? { fields } : {}) };
  }
  if (status === "unavailable" || res.ok) return { ok: false, error: "unavailable" };
  if ((raw as { error?: unknown } | null | undefined)?.error === "login_required") return { ok: false, error: "ended" };
  if (res.status === 404) return { ok: false, error: "not_available" };
  return { ok: false, error: "unavailable" };
}

/** `events/read`. Never throws and is never retried. */
export async function eventsRead(
  config: WebsiteKitConfig,
  sessionToken: string,
  slug: string,
  timeoutMs: number
): Promise<EventCallResult<Record<string, unknown>>> {
  return eventCall(await post(config, "events/read", { sessionToken, slug }, timeoutMs));
}

/** `events/register`. Never throws and is NEVER retried here: it takes a seat. */
export async function eventsRegister(
  config: WebsiteKitConfig,
  sessionToken: string,
  input: Record<string, unknown> & { slug: string },
  timeoutMs: number
): Promise<EventCallResult<Record<string, unknown>>> {
  return eventCall(await post(config, "events/register", { sessionToken, ...input }, timeoutMs));
}
