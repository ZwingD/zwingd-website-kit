/**
 * Checkout v3.2: the buyer proves their email by code before payment (spec
 * §4, §8, §10b A1-A3). The code step creates NO account and NO session: a
 * right code gives the site's server a verified-email proof, held only in the
 * HttpOnly `__Host-zw_proof` cookie, and payment goes ahead against it.
 *
 *   GET  /session/code-step          same-origin read: the form value (`csrf`)
 *                                    and the open step a reload resumes.
 *   POST /session/code-start         same-site POST + CSRF. `email`, `offer?`, `country?`, `botToken?`.
 *                                    With no country (the page's, else the kit's
 *                                    `visitorCountry`) it answers 400
 *                                    COUNTRY_REQUIRED and sends NO code, for
 *                                    every email alike (Helm #4 on #1963).
 *   POST /session/code-resend        same-site POST + CSRF. An expired ticket
 *                                    starts again with the stored email (§8).
 *   POST /session/code-verify        same-site POST + CSRF. `code`, `firstName?`,
 *                                    `lastName?`, `acceptedDocuments?` (JSON) and
 *                                    the purchase (`offer`, `expectedTotalMinor`,
 *                                    `expectedCurrencyCode`, `country?`,
 *                                    `couponCode?`, `paymentGateway?`,
 *                                    attribution). `country` is the master-data
 *                                    country id the page priced the guest total
 *                                    in; it wins over the kit's `visitorCountry`.
 *                                    A purchase field missing or in the wrong
 *                                    shape is 400 INVALID_REQUEST BEFORE the
 *                                    code is spent. Verify → proof cookie →
 *                                    re-quote with the proof → unchanged total
 *                                    and currency: `checkout/start` at once;
 *                                    changed: `confirm-price` (A2).
 *   POST /session/code-pay           same-site POST + CSRF. "Pay {amount}": a
 *                                    start with the proof at the shown total and
 *                                    currency (`expectedCurrencyCode`, Helm #14).
 *   POST /session/code-requote       same-site POST + CSRF. A reload while the
 *                                    proof is held (Helm #18): the purchase is
 *                                    quoted again with it and always answered as
 *                                    `confirm-price` ("Pay {amount}"), never a start.
 *   POST /session/checkout-continue  same-site POST + CSRF, the thank-you
 *                                    button's fetch. Mints the 60 s continue
 *                                    nonce NOW (never on a page load) and
 *                                    answers `{ nonce, continueUrl }`; the
 *                                    button POSTs it to the app in a form (A3).
 *                                    `orderId` names the order on screen: the
 *                                    kit mints only when the held proof started
 *                                    that order in this browser (Helm #26, a
 *                                    kit-only check; the API names no order).
 *
 * ⛔ The proof never reaches page JavaScript or an address: only the server
 * reads the cookie, and no answer carries it. The nonce goes only to the
 * button's press handler and into the body of a form POST, never into a URL.
 * ⛔ The ticket lives only in the HttpOnly ticket cookie; nothing here logs an
 * email, a code, a ticket, a proof or a nonce.
 */
import {
  checkoutQuote,
  checkoutStart,
  codeResend,
  codeStart,
  codeVerify,
  proofContext,
  proofContinue,
  PROOF_PATTERN,
  reportDropOff,
  type AcceptedDocument,
  type CheckoutFailure,
  type CodeResult,
  type CodeTicket,
  type ContinueAs,
  type MemberQuoteInput,
  type MemberStartInput,
} from "./api-client.ts";
import { CHECKOUT_ATTRIBUTION_KEYS, CHECKOUT_RETURN_PATH } from "./checkout.ts";
import type { CodeStepPayment, CodeStepRefusal, CodeStepTicket, HeldCodeStep, PendingCodeStep } from "./code-step.ts";
import { CODE_STEP_COPY, PROOF_GONE_REASONS, UNAVAILABLE_REASON } from "./code-step.ts";
import { ipOf, type WebsiteKitConfig } from "./config.ts";
import { clearCookie, serializeCookie, TICKET_COOKIE_MAX_AGE_S, type CookieNames } from "./cookies.ts";
import type { RequestView, ResponseView } from "./flows.ts";
import { base64url } from "./pkce.ts";
import { sameSitePost } from "./same-site.ts";

export const CODE_PATHS = Object.freeze({
  codeStep: "/session/code-step",
  codeStart: "/session/code-start",
  codeResend: "/session/code-resend",
  codeVerify: "/session/code-verify",
  codePay: "/session/code-pay",
  codeRequote: "/session/code-requote",
  checkoutContinue: "/session/checkout-continue",
});

/** What GET /session/code-step answers. */
export interface CodeStepRead {
  /** The value the code step's POSTs (and the thank-you button) send as `csrf`. */
  formToken: string;
  /** The open step from the ticket cookie, or null. */
  pending: PendingCodeStep | null;
  /** A proof the server still holds (a reload after the code): resume at "Pay {amount}" for this offer. Else null. */
  held: HeldCodeStep | null;
}

/** The thank-you button the server picked from the proof context (§8 step 4). Never the proof itself. */
export interface CheckoutContinue {
  /** The order this button continues from (the one on the thank-you page, started by this browser's proof); the press sends it (Helm #26). */
  orderId: string;
  /**
   * Which button. The buyer's own fact on their own page (Helm #19 waived §8 step 4 for it): ⛔ never put it in
   * browser storage, an address or a log.
   */
  continueAs: ContinueAs;
  /** "Continue sign-up" or "Go to my course" (§8a). */
  label: string;
  /** Where the button's press POSTs (with `csrf`): the kit's own route. */
  action: string;
  /** The app's normal sign-in: where the press goes when the continue cannot be made (E10). */
  signInUrl: string;
}

/**
 * What POST /session/checkout-continue answers the button's fetch: the
 * 60 s single-use nonce and the app's continue route (200), or the app's
 * normal sign-in (400, past the same-site check; that refusal is a bare 403). Never the proof.
 */
export type CheckoutContinueAnswer = { nonce: string; continueUrl: string } | { signInUrl: string };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const DIGITS = /^\d{1,12}$/;
const EXPECTED_TOTAL = /^\d{1,18}$/;
const CURRENCY = /^[A-Z]{3}$/;
// eslint-disable-next-line no-control-regex
const COUPON = /^[^\u0000-\u001f\u007f]{1,64}$/;
const BOT_TOKEN_MAX = 4096;
const NAME_MAX = 60;
const DOCS_MAX = 10;
const DOC_VALUE_MAX = 64;
const ATTRIBUTION_MAX = 200;
/** The most the API's PAID extension adds past the verify-time life (30 min after payment, spec §4.3, A7). */
const PROOF_PAID_EXTENSION_S = 30 * 60;
/** The "code sent" report's own cap: the step waits for it, so a slow intake never holds the buyer long. */
const DROP_OFF_TIMEOUT_MS = 2_000;
/** Refusals of a checkout call with a proof after which the proof is no good: the cookie is dropped. */
const PROOF_GONE: ReadonlySet<string> = new Set(PROOF_GONE_REASONS);

interface TicketCookie {
  t: string;
  e: string;
  o?: string;
  /** The country the code was asked in (a master-data id), so "Send a new code" after expiry can start again (#4). */
  c?: string;
  l: number;
  x: number;
  r: string;
  /** 1 once the code was right: the cookie then only remembers the email and offer of the held proof (`x` = its end). */
  v?: 1;
  /** The order the held proof last started (a master-data id): the thank-you button belongs to it alone (Helm #26). */
  d?: string;
}

const baseHeaders = (): Record<string, string> => ({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });

function json(status: number, body: unknown, setCookies: string[] = []): ResponseView {
  return { status, headers: { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8" }, setCookies, body: JSON.stringify(body) };
}

const methodNotAllowed = (allow: string): ResponseView => ({ status: 405, headers: { ...baseHeaders(), Allow: allow }, setCookies: [] });
const forbidden = (): ResponseView => ({ status: 403, headers: baseHeaders(), setCookies: [] });

function encodeTicket(value: TicketCookie): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** The ticket cookie, kept after the code itself has expired (`x` in the past) so a restart knows the email. */
function decodeTicket(raw: string | undefined): TicketCookie | null {
  if (!raw || !/^[A-Za-z0-9_-]{1,2048}$/.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((raw.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Partial<TicketCookie>;
    if (typeof v.t !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.t)) return null;
    if (typeof v.e !== "string" || !EMAIL.test(v.e)) return null;
    if (typeof v.l !== "number" || typeof v.x !== "number" || typeof v.r !== "string" || Number.isNaN(Date.parse(v.r))) return null;
    return {
      t: v.t,
      e: v.e,
      l: v.l,
      x: v.x,
      r: v.r,
      ...(typeof v.o === "string" && OBJECT_ID.test(v.o) ? { o: v.o } : {}),
      ...(typeof v.c === "string" && OBJECT_ID.test(v.c) ? { c: v.c } : {}),
      ...(v.v === 1 ? { v: 1 as const } : {}),
      ...(typeof v.d === "string" && OBJECT_ID.test(v.d) ? { d: v.d } : {}),
    };
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
 * `acceptedDocuments` as the form's JSON: at most the first 10 items are kept.
 * An item whose type or version is missing or outside 1-64 characters is
 * dropped here (the gateway would refuse it `invalid_request`); a number
 * version is sent as its string. With none left, no `acceptedDocuments` is
 * sent, and the API answers WEBSITE_TERMS_REQUIRED if it needs them.
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
    // The gateway's own code: 429 (locked, rate limited), 503 (BOT_CHECK_UNAVAILABLE), 409 (WEBSITE_CODE_DISABLED), else 400.
    const status = res.status === 429 || res.status === 503 || res.status === 409 ? res.status : 400;
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
  csrfFor(cookies: Record<string, string>): { token: string; setCookie: string | null };
  /** True when the request is a same-origin read (as /session/me checks). */
  sameOriginRead(req: RequestView): boolean;
  /** For tests: the checkout call timeouts. */
  quoteTimeoutMs?: number;
  startTimeoutMs?: number;
}

export interface CodeRoutes {
  codeStep(req: RequestView): Promise<ResponseView>;
  codeStart(req: RequestView): Promise<ResponseView>;
  codeResend(req: RequestView): Promise<ResponseView>;
  codeVerify(req: RequestView): Promise<ResponseView>;
  codePay(req: RequestView): Promise<ResponseView>;
  codeRequote(req: RequestView): Promise<ResponseView>;
  checkoutContinue(req: RequestView): Promise<ResponseView>;
  /**
   * Server only: the thank-you button for THIS order from `checkout-proof/context`, or null (no proof, not valid
   * any more, the held proof did not start this order in this browser, or a malformed order id).
   */
  checkoutContinueFor(cookies: Record<string, string>, input: { orderId: string }): Promise<CheckoutContinue | null>;
  /** The `Set-Cookie` values that drop the code step's cookies (sign-out). */
  clearCookies(): string[];
}

export function createCodeRoutes(deps: CodeRoutesDeps): CodeRoutes {
  const { config, names } = deps;
  const local = config.insecureLocalCookies;
  const clearTicket = () => clearCookie(names.ticket, "Lax", local);
  const clearProof = () => clearCookie(names.proof, "Lax", local);
  const sameSiteForm = (req: RequestView) => sameSitePost(req, { origin: config.origin, csrfCookie: names.csrf });
  const returnUrl = `${config.origin}${CHECKOUT_RETURN_PATH}`;
  const appHome = `${config.appUrl}/`;

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

  async function visitorCountryOf(req: RequestView): Promise<string | undefined> {
    if (!config.visitorCountry) return undefined;
    try {
      const value = await config.visitorCountry(req);
      return typeof value === "string" && OBJECT_ID.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Helm #26: the held proof started `orderId` in this browser (the held-proof cookie remembers it). */
  function startedHere(cookies: Record<string, string>, orderId: string): boolean {
    const t = decodeTicket(cookies[names.ticket]);
    return t?.v === 1 && t.d === orderId && t.x > config.now();
  }

  function proofOf(cookies: Record<string, string>): string | null {
    const value = cookies[names.proof];
    return typeof value === "string" && PROOF_PATTERN.test(value) ? value : null;
  }

  /**
   * "Code sent" ("verified" is identity's own, B5). Awaited, at most DROP_OFF_TIMEOUT_MS, and never throws: a
   * promise left running after the answer is frozen or dropped on serverless hosts, so the report would be lost.
   */
  async function dropOff(email: string, offer: string | undefined): Promise<void> {
    if (!offer) return;
    await reportDropOff(config, { email, offer, stage: "code_sent" }, DROP_OFF_TIMEOUT_MS).catch(() => undefined);
  }

  function ticketCookie(ticket: CodeTicket, email: string, offer: string | undefined, country: string | undefined): string {
    const now = config.now();
    const value: TicketCookie = {
      t: ticket.ticketId,
      e: email,
      l: ticket.codeLength,
      x: now + ticket.codeExpiresInSeconds * 1000,
      r: ticket.resendAvailableAt,
      ...(offer ? { o: offer } : {}),
      ...(country ? { c: country } : {}),
    };
    return serializeCookie(names.ticket, encodeTicket(value), { sameSite: "Lax", maxAge: TICKET_COOKIE_MAX_AGE_S }, local);
  }

  /**
   * Helm #26: the held proof started `orderId` (or settled it at once). Remembered in the held-proof cookie, for the
   * rest of its life, so the thank-you page shows the button only for that order. Null when nothing is held.
   */
  function startedCookie(t: TicketCookie | null, orderId: string): string | null {
    if (!t || t.v !== 1) return null;
    const maxAgeS = Math.max(0, Math.floor((t.x - config.now()) / 1000));
    if (maxAgeS === 0) return null;
    return serializeCookie(names.ticket, encodeTicket({ ...t, d: orderId }), { sameSite: "Lax", maxAge: maxAgeS }, local);
  }

  const browserTicket = (t: CodeTicket): CodeStepTicket => ({ codeLength: t.codeLength, codeExpiresInSeconds: t.codeExpiresInSeconds, resendAvailableAt: t.resendAvailableAt });

  /** True when the page sent `name` (non-empty) but not in the shape `pattern` takes. */
  const malformed = (form: Record<string, string>, name: string, pattern: RegExp) =>
    typeof form[name] === "string" && form[name] !== "" && !pattern.test(form[name]!);

  /** A purchase the kit can pay for: every field checked, nothing the page did not send in the right shape. */
  interface Purchase {
    offer: string;
    expectedTotalMinor: string;
    /** The currency of the shown total: compared on verify (A2) and sent with every start (Helm #14). */
    expectedCurrencyCode: string;
    couponCode?: string;
    paymentGateway?: string;
    country?: string;
    attribution?: Record<string, string>;
  }

  /**
   * The purchase the page posts with verify and pay: never a price it was not shown, never a return address.
   * Null (the route answers INVALID_REQUEST) when a required field is missing or any field the page sent is in the
   * wrong shape: refused before the code is spent, never dropped (a dropped country or coupon re-quotes another
   * price and shows a false "member price").
   */
  function purchaseOf(form: Record<string, string>, fallbackOffer: string | undefined): Purchase | null {
    const offer = typeof form.offer === "string" && OBJECT_ID.test(form.offer) ? form.offer : fallbackOffer;
    const expectedTotalMinor = typeof form.expectedTotalMinor === "string" && EXPECTED_TOTAL.test(form.expectedTotalMinor) ? form.expectedTotalMinor : null;
    // The currency of the shown total: a re-quote with the same number in another currency is not "unchanged" (A2).
    const expectedCurrencyCode = typeof form.expectedCurrencyCode === "string" && CURRENCY.test(form.expectedCurrencyCode) ? form.expectedCurrencyCode : null;
    if (!offer || expectedTotalMinor === null || expectedCurrencyCode === null) return null;
    const bad =
      malformed(form, "offer", OBJECT_ID) ||
      malformed(form, "expectedTotalMinor", EXPECTED_TOTAL) ||
      malformed(form, "expectedCurrencyCode", CURRENCY) ||
      malformed(form, "country", OBJECT_ID) ||
      malformed(form, "couponCode", COUPON) ||
      malformed(form, "paymentGateway", OBJECT_ID);
    if (bad) return null;
    const couponCode = typeof form.couponCode === "string" && COUPON.test(form.couponCode) ? form.couponCode : undefined;
    const paymentGateway = typeof form.paymentGateway === "string" && OBJECT_ID.test(form.paymentGateway) ? form.paymentGateway : undefined;
    // The country the page priced `expectedTotalMinor` in (e.g. one the buyer picked), as a master-data id.
    const country = typeof form.country === "string" && OBJECT_ID.test(form.country) ? form.country : undefined;
    const attribution: Record<string, string> = {};
    for (const key of CHECKOUT_ATTRIBUTION_KEYS) {
      const value = form[key];
      if (typeof value === "string" && value.trim() !== "") attribution[key] = value.trim().slice(0, ATTRIBUTION_MAX);
    }
    return {
      offer,
      expectedTotalMinor,
      expectedCurrencyCode,
      ...(couponCode ? { couponCode } : {}),
      ...(paymentGateway ? { paymentGateway } : {}),
      ...(country ? { country } : {}),
      ...(Object.keys(attribution).length > 0 ? { attribution } : {}),
    };
  }

  /**
   * The country to quote and start in: the one the page priced the shown total
   * in, else the kit's `visitorCountry` (the geo header). It is sent as `visitorCountry`, the API's FALLBACK: for a
   * verified member the API prices in the profile country first (A2, Helm #23
   * on #1963), so the kit never overrides it; a changed total is shown before
   * any payment ("Pay {amount}"). For a non-member it keeps the shown total.
   */
  async function countryFor(p: Purchase, req: RequestView): Promise<string | undefined> {
    return p.country ?? (await visitorCountryOf(req));
  }

  function failed(error: CheckoutFailure, reason: string | undefined): CodeStepPayment {
    if (error === "checkout_refused" && reason) return { kind: "payment-failed", reason };
    return { kind: "payment-failed", reason: UNAVAILABLE_REASON };
  }

  /** The answer, with the proof cookie dropped when the API says the proof is no good. */
  function paymentAnswer(answer: CodeStepPayment, setCookies: string[] = []): ResponseView {
    const gone = answer.kind === "payment-failed" && PROOF_GONE.has(answer.reason);
    // The proof is gone: drop it, and the held-proof marker with it.
    const dropped = [`${names.proof}=`, `${names.ticket}=`];
    return json(200, answer, gone ? [...setCookies.filter((c) => !dropped.some((d) => c.startsWith(d))), clearProof(), clearTicket()] : setCookies);
  }

  /**
   * A start with the proof at `p.expectedTotalMinor`. ONE start, never retried;
   * on PRICE_CHANGED the price is quoted again ONCE and shown (A2): nothing is
   * started at a price the buyer has not seen.
   */
  async function startWithProof(buyer: { checkoutProof: string; buyerIp: string }, p: Purchase, country: string | undefined): Promise<CodeStepPayment> {
    const quoteInput: MemberQuoteInput = { offer: p.offer, ...(p.couponCode ? { couponCode: p.couponCode } : {}), ...(country ? { visitorCountry: country } : {}) };
    const input: MemberStartInput = {
      ...quoteInput,
      ...(p.paymentGateway ? { paymentGateway: p.paymentGateway } : {}),
      expectedTotalMinor: p.expectedTotalMinor,
      ...(p.expectedCurrencyCode ? { expectedCurrencyCode: p.expectedCurrencyCode } : {}),
      // Always the site's own return page: never an address from the browser.
      returnUrl,
      ...(p.attribution ? { attribution: p.attribution } : {}),
    };
    const started = await checkoutStart(config, buyer, input, deps.startTimeoutMs);
    if (started.ok) {
      const s = started.body;
      return {
        kind: "redirect",
        url: s.redirectUrl ?? `${returnUrl}/${s.orderId}`,
        orderId: s.orderId,
        orderToken: s.orderToken,
        orderTokenExpiresAt: s.orderTokenExpiresAt,
        settled: s.redirectUrl === null || s.paymentState === "PAID",
      };
    }
    if (started.error === "checkout_refused" && started.reason === "ALREADY_ENROLLED") return { kind: "already-owned" };
    if (started.error === "checkout_refused" && started.reason === "PRICE_CHANGED") {
      const requoted = await checkoutQuote(config, buyer, quoteInput, deps.quoteTimeoutMs);
      if (!requoted.ok) return failed(requoted.error, requoted.reason);
      if (requoted.body.alreadyEnrolled) return { kind: "already-owned" };
      const q = requoted.body;
      return { kind: "confirm-price", totalMinor: q.totalMinor, currencyCode: q.currencyCode, minorUnitExponent: q.minorUnitExponent };
    }
    return failed(started.error, started.reason);
  }

  /** A2: re-quote with the proof; an unchanged total starts at once, a changed one is shown first. */
  async function payAfterVerify(buyer: { checkoutProof: string; buyerIp: string }, p: Purchase, country: string | undefined): Promise<CodeStepPayment> {
    const quoted = await checkoutQuote(
      config,
      buyer,
      { offer: p.offer, ...(p.couponCode ? { couponCode: p.couponCode } : {}), ...(country ? { visitorCountry: country } : {}) },
      deps.quoteTimeoutMs,
    );
    if (!quoted.ok) return failed(quoted.error, quoted.reason);
    const q = quoted.body;
    if (q.alreadyEnrolled) return { kind: "already-owned" };
    if (q.totalMinor !== p.expectedTotalMinor || q.currencyCode !== p.expectedCurrencyCode) {
      return { kind: "confirm-price", totalMinor: q.totalMinor, currencyCode: q.currencyCode, minorUnitExponent: q.minorUnitExponent };
    }
    return startWithProof(buyer, p, country);
  }

  async function codeStep(req: RequestView): Promise<ResponseView> {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed("GET");
    if (!deps.sameOriginRead(req)) return forbidden();
    const csrf = deps.csrfFor(req.cookies);
    const t = decodeTicket(req.cookies[names.ticket]);
    // A held proof is offered for resuming only while both cookies say it lives (the API decides at the re-quote).
    const held = t?.v === 1 && t.x > config.now() && proofOf(req.cookies) !== null;
    const answer: CodeStepRead = {
      formToken: csrf.token,
      pending: t && t.v !== 1 ? { email: t.e, codeLength: t.l, codeExpiresAt: new Date(t.x).toISOString(), resendAvailableAt: t.r } : null,
      held: held ? { email: t!.e, offer: t!.o ?? null } : null,
    };
    const view = json(200, answer, csrf.setCookie ? [csrf.setCookie] : []);
    view.headers.Vary = "Cookie";
    if (req.method === "HEAD") delete view.body;
    return view;
  }

  async function start(email: string, offer: string | undefined, country: string | undefined, buyerIp: string, botToken: string | undefined): Promise<ResponseView> {
    // Helm #4: no country, no code. Decided before the API is asked, the same for every email (nothing is spent or enumerated).
    if (!country) return json(400, { reason: "COUNTRY_REQUIRED" } satisfies CodeStepRefusal);
    const res = await codeStart(config, { email, buyerIp, ...(botToken ? { botToken } : {}) });
    if (!res.ok) {
      const r = refusalOf(res);
      return json(r.status, r.body);
    }
    await dropOff(email, offer);
    // A new ticket: any proof from an earlier email is dropped (E4).
    return json(200, browserTicket(res.body), [ticketCookie(res.body, email, offer, country), clearProof()]);
  }

  async function startRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const form = req.form ?? {};
    const email = typeof form.email === "string" ? form.email.trim().toLowerCase() : "";
    if (email.length > 254 || !EMAIL.test(email)) return json(400, { reason: "WEBSITE_CODE_EMAIL_INVALID" } satisfies CodeStepRefusal);
    const offer = typeof form.offer === "string" && OBJECT_ID.test(form.offer) ? form.offer : undefined;
    if (malformed(form, "country", OBJECT_ID)) return json(400, { reason: "INVALID_REQUEST" } satisfies CodeStepRefusal);
    const botToken = typeof form.botToken === "string" && form.botToken !== "" && form.botToken.length <= BOT_TOKEN_MAX ? form.botToken : undefined;
    const buyerIp = buyerIpOf(req);
    if (!buyerIp) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal);
    const country = typeof form.country === "string" && form.country !== "" ? form.country : await visitorCountryOf(req);
    return start(email, offer, country, buyerIp, botToken);
  }

  async function resendRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const t = decodeTicket(req.cookies[names.ticket]);
    // A held-proof marker is not an open step: nothing to resend.
    if (!t || t.v === 1) return json(400, { reason: "WEBSITE_CODE_EXPIRED" } satisfies CodeStepRefusal, t ? [] : [clearTicket()]);
    const buyerIp = buyerIpOf(req);
    if (!buyerIp) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal);
    const restart = async () => start(t.e, t.o, t.c ?? (await visitorCountryOf(req)), buyerIp, undefined);

    // §8: on an expired ticket, "Send a new code" starts again with the stored email.
    if (t.x <= config.now()) return restart();
    const res = await codeResend(config, { ticketId: t.t, buyerIp });
    if (!res.ok) {
      if (res.error === "refused" && res.reason === "WEBSITE_CODE_EXPIRED") return restart();
      const r = refusalOf(res);
      return json(r.status, r.body);
    }
    return json(200, browserTicket(res.body), [ticketCookie(res.body, t.e, t.o, t.c)]);
  }

  async function verifyRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const t = decodeTicket(req.cookies[names.ticket]);
    if (!t || t.v === 1 || t.x <= config.now()) return json(400, { reason: "WEBSITE_CODE_EXPIRED" } satisfies CodeStepRefusal);
    const form = req.form ?? {};
    const code = typeof form.code === "string" ? form.code.replace(/\D+/g, "") : "";
    // No digits, or more than 12: the code's shape is wrong, so it isn't right (no guess is spent).
    if (!DIGITS.test(code)) return json(400, { reason: "WEBSITE_CODE_INVALID" } satisfies CodeStepRefusal);
    const purchase = purchaseOf(form, t.o);
    // Before the code is spent: a purchase the kit could not pay for would leave the buyer with a used code.
    if (!purchase) return json(400, { reason: "INVALID_REQUEST" } satisfies CodeStepRefusal);
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

    // The proof: HttpOnly. No account, no session (D2). The cookie outlives the verify-time life by the PAID
    // extension (30 min after payment, A7), so a buyer who pays near the end still gets the thank-you button; past
    // the proof's real life the context read answers invalid and no button shows.
    const proofMaxAge = res.body.proofExpiresInSeconds + PROOF_PAID_EXTENSION_S;
    const buyer = { checkoutProof: res.body.proof, buyerIp };
    const answer = await payAfterVerify(buyer, purchase, await countryFor(purchase, req));
    const held: TicketCookie = { ...t, v: 1, x: config.now() + proofMaxAge * 1000, ...(answer.kind === "redirect" ? { d: answer.orderId } : {}) };
    const setCookies = [
      serializeCookie(names.proof, res.body.proof, { sameSite: "Lax", maxAge: proofMaxAge }, local),
      // The ticket is used up; the cookie now only marks the held proof (and the order it started), so a reload
      // resumes at "Pay" (Helm #18) and the thank-you button belongs to that order alone (Helm #26).
      serializeCookie(names.ticket, encodeTicket(held), { sameSite: "Lax", maxAge: proofMaxAge }, local),
    ];
    return paymentAnswer(answer, setCookies);
  }

  async function payRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const purchase = purchaseOf(req.form ?? {}, undefined);
    if (!purchase) return json(400, { reason: "INVALID_REQUEST" } satisfies CodeStepRefusal);
    const proof = proofOf(req.cookies);
    if (!proof) return paymentAnswer({ kind: "payment-failed", reason: "CHECKOUT_PROOF_INVALID" });
    const buyerIp = buyerIpOf(req);
    if (!buyerIp) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal);
    const answer = await startWithProof({ checkoutProof: proof, buyerIp }, purchase, await countryFor(purchase, req));
    const started = answer.kind === "redirect" ? startedCookie(decodeTicket(req.cookies[names.ticket]), answer.orderId) : null;
    return paymentAnswer(answer, started ? [started] : []);
  }

  /**
   * Helm #18: a reload while the proof is held. The purchase is quoted again with the proof and ALWAYS answered as
   * `confirm-price`, so the buyer presses "Pay {amount}" at the price they are shown; nothing starts here. A proof
   * the API no longer takes answers the proof-gone `payment-failed` (the step goes back to the email, quietly).
   */
  async function requoteRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const purchase = purchaseOf(req.form ?? {}, undefined);
    if (!purchase) return json(400, { reason: "INVALID_REQUEST" } satisfies CodeStepRefusal);
    const proof = proofOf(req.cookies);
    const held = decodeTicket(req.cookies[names.ticket]);
    if (!proof || held?.v !== 1) return paymentAnswer({ kind: "payment-failed", reason: "CHECKOUT_PROOF_INVALID" });
    const buyerIp = buyerIpOf(req);
    if (!buyerIp) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal);
    const country = await countryFor(purchase, req);
    const quoted = await checkoutQuote(
      config,
      { checkoutProof: proof, buyerIp },
      { offer: purchase.offer, ...(purchase.couponCode ? { couponCode: purchase.couponCode } : {}), ...(country ? { visitorCountry: country } : {}) },
      deps.quoteTimeoutMs,
    );
    if (!quoted.ok) return paymentAnswer(failed(quoted.error, quoted.reason));
    const q = quoted.body;
    if (q.alreadyEnrolled) return paymentAnswer({ kind: "already-owned" });
    return paymentAnswer({ kind: "confirm-price", totalMinor: q.totalMinor, currencyCode: q.currencyCode, minorUnitExponent: q.minorUnitExponent });
  }

  async function checkoutContinueFor(cookies: Record<string, string>, input: { orderId: string }): Promise<CheckoutContinue | null> {
    const orderId = typeof input?.orderId === "string" && OBJECT_ID.test(input.orderId) ? input.orderId : null;
    const proof = proofOf(cookies);
    // Helm #26 (option a, kit only): the button belongs to the order on this page, and only when the held proof
    // started that order in this browser. The API's context names no order, so this is the kit's own check.
    if (!proof || !orderId || !startedHere(cookies, orderId)) return null;
    const res = await proofContext(config, { proof });
    if (!res.ok) return null;
    const continueAs = res.body.continueAs;
    return {
      orderId,
      continueAs,
      label: continueAs === "sign-up" ? CODE_STEP_COPY.continueSignUp : CODE_STEP_COPY.goToCourse,
      action: CODE_PATHS.checkoutContinue,
      signInUrl: appHome,
    };
  }

  /**
   * The thank-you press (A3), fetched by `CheckoutContinueButton`. The nonce is
   * minted here, at the press, and answered as JSON to that one handler, which
   * POSTs it to `continueUrl` in a form at once and keeps it nowhere else. The
   * proof never leaves the server. Past the same-site check (403), anything
   * wrong answers 400 `{ signInUrl }`, the app's normal sign-in (E10); nothing
   * says why.
   */
  async function continueRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const signIn = (setCookies: string[] = []): ResponseView => json(400, { signInUrl: appHome } satisfies CheckoutContinueAnswer, setCookies);
    const proof = proofOf(req.cookies);
    const form = req.form ?? {};
    const orderId = typeof form.orderId === "string" && OBJECT_ID.test(form.orderId) ? form.orderId : null;
    if (!proof || !orderId || !startedHere(req.cookies, orderId)) return signIn();
    const minted = await proofContinue(config, { proof });
    if (!minted.ok) return signIn(minted.error === "refused" && minted.reason === "CHECKOUT_PROOF_INVALID" ? [clearProof()] : []);
    // The proof cookie stays while the API still mints: the app decides a second use (U9a, "That link has
    // expired"). Once the API refuses the mint CHECKOUT_PROOF_INVALID, the cookie is dropped above.
    return json(200, { nonce: minted.body.nonce, continueUrl: minted.body.continueUrl } satisfies CheckoutContinueAnswer);
  }

  return {
    codeStep,
    codeStart: startRoute,
    codeResend: resendRoute,
    codeVerify: verifyRoute,
    codePay: payRoute,
    codeRequote: requoteRoute,
    checkoutContinue: continueRoute,
    checkoutContinueFor,
    clearCookies: () => [clearTicket(), clearProof()],
  };
}
