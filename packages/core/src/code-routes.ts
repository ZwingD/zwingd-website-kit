/**
 * Checkout v3.2: the buyer proves their email by code before payment (spec
 * §4, §8, §10b A1-A3). The code step creates NO account and NO session: a
 * right code gives the site's server a verified-email proof, held only in the
 * HttpOnly `__Host-zw_proof` cookie, and payment goes ahead against it.
 *
 *   GET  /session/code-step          same-origin read: the form value (`csrf`)
 *                                    and the open step a reload resumes.
 *   POST /session/code-start         same-site POST + CSRF. `email`, `offer?`, `botToken?`.
 *   POST /session/code-resend        same-site POST + CSRF. An expired ticket
 *                                    starts again with the stored email (§8).
 *   POST /session/code-verify        same-site POST + CSRF. `code`, `firstName?`,
 *                                    `lastName?`, `acceptedDocuments?` (JSON) and
 *                                    the purchase (`offer`, `expectedTotalMinor`,
 *                                    `country?`, `couponCode?`, `paymentGateway?`,
 *                                    attribution). `country` is the master-data
 *                                    country id the page priced the guest total
 *                                    in; it wins over the kit's `visitorCountry`.
 *                                    Verify → proof cookie → re-quote with the
 *                                    proof → unchanged total: `checkout/start`
 *                                    at once; changed: `confirm-price` (A2).
 *   POST /session/code-pay           same-site POST + CSRF. "Pay {amount}": a
 *                                    start with the proof at the shown total.
 *   POST /session/checkout-continue  same-site POST + CSRF, the thank-you
 *                                    button's fetch. Mints the 60 s continue
 *                                    nonce NOW (never on a page load) and
 *                                    answers `{ nonce, continueUrl }`; the
 *                                    button POSTs it to the app in a form (A3).
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
import type { CodeStepPayment, CodeStepRefusal, CodeStepTicket, PendingCodeStep } from "./code-step.ts";
import { CODE_STEP_COPY, UNAVAILABLE_REASON } from "./code-step.ts";
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
  checkoutContinue: "/session/checkout-continue",
});

/** What GET /session/code-step answers. */
export interface CodeStepRead {
  /** The value the code step's POSTs (and the thank-you button) send as `csrf`. */
  formToken: string;
  /** The open step from the ticket cookie, or null. */
  pending: PendingCodeStep | null;
}

/** The thank-you button the server picked from the proof context (§8 step 4). Never the proof itself. */
export interface CheckoutContinue {
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
 * normal sign-in (400). Never the proof.
 */
export type CheckoutContinueAnswer = { nonce: string; continueUrl: string } | { signInUrl: string };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const DIGITS = /^\d{1,12}$/;
const EXPECTED_TOTAL = /^\d{1,18}$/;
// eslint-disable-next-line no-control-regex
const COUPON = /^[^\u0000-\u001f\u007f]{1,64}$/;
const BOT_TOKEN_MAX = 4096;
const NAME_MAX = 60;
const DOCS_MAX = 10;
const DOC_VALUE_MAX = 64;
const ATTRIBUTION_MAX = 200;
/** Refusals of a checkout call with a proof after which the proof is no good: the cookie is dropped. */
const PROOF_GONE = new Set(["CHECKOUT_PROOF_INVALID", "CHECKOUT_PROOF_EMAIL_MISMATCH", "EMAIL_VERIFICATION_REQUIRED"]);

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
  checkoutContinue(req: RequestView): Promise<ResponseView>;
  /** Server only: the thank-you button from `checkout-proof/context`, or null (no proof, or not valid any more). */
  checkoutContinueFor(cookies: Record<string, string>): Promise<CheckoutContinue | null>;
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

  function proofOf(cookies: Record<string, string>): string | null {
    const value = cookies[names.proof];
    return typeof value === "string" && PROOF_PATTERN.test(value) ? value : null;
  }

  function dropOff(email: string, offer: string | undefined): void {
    if (!offer) return;
    // Fire-and-forget: never awaited, never blocks the step, never throws. "verified" is identity's own (B5).
    void reportDropOff(config, { email, offer, stage: "code_sent" }).catch(() => undefined);
  }

  function ticketCookie(ticket: CodeTicket, email: string, offer: string | undefined): string {
    const now = config.now();
    const value: TicketCookie = { t: ticket.ticketId, e: email, l: ticket.codeLength, x: now + ticket.codeExpiresInSeconds * 1000, r: ticket.resendAvailableAt, ...(offer ? { o: offer } : {}) };
    return serializeCookie(names.ticket, encodeTicket(value), { sameSite: "Lax", maxAge: TICKET_COOKIE_MAX_AGE_S }, local);
  }

  const browserTicket = (t: CodeTicket): CodeStepTicket => ({ codeLength: t.codeLength, codeExpiresInSeconds: t.codeExpiresInSeconds, resendAvailableAt: t.resendAvailableAt });

  /** The purchase the page posts with verify and pay: never a price it was not shown, never a return address. */
  function purchaseOf(form: Record<string, string>, fallbackOffer: string | undefined) {
    const offer = typeof form.offer === "string" && OBJECT_ID.test(form.offer) ? form.offer : fallbackOffer;
    const expectedTotalMinor = typeof form.expectedTotalMinor === "string" && EXPECTED_TOTAL.test(form.expectedTotalMinor) ? form.expectedTotalMinor : null;
    const couponCode = typeof form.couponCode === "string" && COUPON.test(form.couponCode) ? form.couponCode : undefined;
    const paymentGateway = typeof form.paymentGateway === "string" && OBJECT_ID.test(form.paymentGateway) ? form.paymentGateway : undefined;
    // The country the page priced `expectedTotalMinor` in (e.g. one the buyer picked), as a master-data id.
    const country = typeof form.country === "string" && OBJECT_ID.test(form.country) ? form.country : undefined;
    const attribution: Record<string, string> = {};
    for (const key of CHECKOUT_ATTRIBUTION_KEYS) {
      const value = form[key];
      if (typeof value === "string" && value.trim() !== "") attribution[key] = value.trim().slice(0, ATTRIBUTION_MAX);
    }
    return { offer, expectedTotalMinor, couponCode, paymentGateway, country, attribution: Object.keys(attribution).length > 0 ? attribution : undefined };
  }
  type Purchase = ReturnType<typeof purchaseOf> & { offer: string };

  /**
   * The country to quote and start in: the one the page priced the shown total
   * in, else the kit's `visitorCountry` (the geo header). Re-quoting in another
   * country would show a non-member a false "member price". For a member the
   * API still applies its own rule (the profile country first, A2).
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
    return json(200, answer, gone ? [...setCookies.filter((c) => !c.startsWith(`${names.proof}=`)), clearProof()] : setCookies);
  }

  /**
   * A start with the proof at `expectedTotalMinor`. ONE start, never retried;
   * on PRICE_CHANGED the price is quoted again ONCE and shown (A2): nothing is
   * started at a price the buyer has not seen.
   */
  async function startWithProof(buyer: { checkoutProof: string; buyerIp: string }, p: Purchase, expectedTotalMinor: string, country: string | undefined): Promise<CodeStepPayment> {
    const quoteInput: MemberQuoteInput = { offer: p.offer, ...(p.couponCode ? { couponCode: p.couponCode } : {}), ...(country ? { visitorCountry: country } : {}) };
    const input: MemberStartInput = {
      ...quoteInput,
      ...(p.paymentGateway ? { paymentGateway: p.paymentGateway } : {}),
      expectedTotalMinor,
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
    if (p.expectedTotalMinor === null || q.totalMinor !== p.expectedTotalMinor) {
      return { kind: "confirm-price", totalMinor: q.totalMinor, currencyCode: q.currencyCode, minorUnitExponent: q.minorUnitExponent };
    }
    return startWithProof(buyer, p, q.totalMinor, country);
  }

  async function codeStep(req: RequestView): Promise<ResponseView> {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed("GET");
    if (!deps.sameOriginRead(req)) return forbidden();
    const csrf = deps.csrfFor(req.cookies);
    const t = decodeTicket(req.cookies[names.ticket]);
    const answer: CodeStepRead = {
      formToken: csrf.token,
      pending: t ? { email: t.e, codeLength: t.l, codeExpiresAt: new Date(t.x).toISOString(), resendAvailableAt: t.r } : null,
    };
    const view = json(200, answer, csrf.setCookie ? [csrf.setCookie] : []);
    view.headers.Vary = "Cookie";
    if (req.method === "HEAD") delete view.body;
    return view;
  }

  async function start(email: string, offer: string | undefined, buyerIp: string, botToken: string | undefined): Promise<ResponseView> {
    const res = await codeStart(config, { email, buyerIp, ...(botToken ? { botToken } : {}) });
    if (!res.ok) {
      const r = refusalOf(res);
      return json(r.status, r.body);
    }
    dropOff(email, offer);
    // A new ticket: any proof from an earlier email is dropped (E4).
    return json(200, browserTicket(res.body), [ticketCookie(res.body, email, offer), clearProof()]);
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
    return start(email, offer, buyerIp, botToken);
  }

  async function resendRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const t = decodeTicket(req.cookies[names.ticket]);
    if (!t) return json(400, { reason: "WEBSITE_CODE_EXPIRED" } satisfies CodeStepRefusal, [clearTicket()]);
    const buyerIp = buyerIpOf(req);
    if (!buyerIp) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal);

    // §8: on an expired ticket, "Send a new code" starts again with the stored email.
    if (t.x <= config.now()) return start(t.e, t.o, buyerIp, undefined);
    const res = await codeResend(config, { ticketId: t.t, buyerIp });
    if (!res.ok) {
      if (res.error === "refused" && res.reason === "WEBSITE_CODE_EXPIRED") return start(t.e, t.o, buyerIp, undefined);
      const r = refusalOf(res);
      return json(r.status, r.body);
    }
    return json(200, browserTicket(res.body), [ticketCookie(res.body, t.e, t.o)]);
  }

  async function verifyRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const t = decodeTicket(req.cookies[names.ticket]);
    if (!t || t.x <= config.now()) return json(400, { reason: "WEBSITE_CODE_EXPIRED" } satisfies CodeStepRefusal);
    const form = req.form ?? {};
    const code = typeof form.code === "string" ? form.code.replace(/\D+/g, "") : "";
    // No digits at all: the code's shape is wrong, so it isn't right (no guess is spent).
    if (!DIGITS.test(code)) return json(400, { reason: "WEBSITE_CODE_INVALID" } satisfies CodeStepRefusal);
    const purchase = purchaseOf(form, t.o);
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

    // The proof: HttpOnly, only for its own life. No account, no session (D2).
    const setCookies = [
      serializeCookie(names.proof, res.body.proof, { sameSite: "Lax", maxAge: res.body.proofExpiresInSeconds }, local),
      clearTicket(),
    ];
    if (!purchase.offer) return paymentAnswer({ kind: "payment-failed", reason: UNAVAILABLE_REASON }, setCookies);
    const buyer = { checkoutProof: res.body.proof, buyerIp };
    const answer = await payAfterVerify(buyer, purchase as Purchase, await countryFor(purchase as Purchase, req));
    return paymentAnswer(answer, setCookies);
  }

  async function payRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const purchase = purchaseOf(req.form ?? {}, undefined);
    if (!purchase.offer || purchase.expectedTotalMinor === null) return json(400, { reason: "INVALID_REQUEST" } satisfies CodeStepRefusal);
    const proof = proofOf(req.cookies);
    if (!proof) return paymentAnswer({ kind: "payment-failed", reason: "CHECKOUT_PROOF_INVALID" });
    const buyerIp = buyerIpOf(req);
    if (!buyerIp) return json(503, { reason: UNAVAILABLE_REASON } satisfies CodeStepRefusal);
    const answer = await startWithProof({ checkoutProof: proof, buyerIp }, purchase as Purchase, purchase.expectedTotalMinor, await countryFor(purchase as Purchase, req));
    return paymentAnswer(answer);
  }

  async function checkoutContinueFor(cookies: Record<string, string>): Promise<CheckoutContinue | null> {
    const proof = proofOf(cookies);
    if (!proof) return null;
    const res = await proofContext(config, { proof });
    if (!res.ok) return null;
    const continueAs = res.body.continueAs;
    return {
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
   * proof never leaves the server. Anything wrong answers `signInUrl`, the
   * app's normal sign-in (E10); nothing says why.
   */
  async function continueRoute(req: RequestView): Promise<ResponseView> {
    if (req.method !== "POST") return methodNotAllowed("POST");
    if (!sameSiteForm(req)) return forbidden();
    const signIn = (setCookies: string[] = []): ResponseView => json(400, { signInUrl: appHome } satisfies CheckoutContinueAnswer, setCookies);
    const proof = proofOf(req.cookies);
    if (!proof) return signIn();
    const minted = await proofContinue(config, { proof });
    if (!minted.ok) return signIn(minted.error === "refused" && minted.reason === "CHECKOUT_PROOF_INVALID" ? [clearProof()] : []);
    // The proof cookie stays: a second press mints again, and the app answers "That link has expired" (U9a).
    return json(200, { nonce: minted.body.nonce, continueUrl: minted.body.continueUrl } satisfies CheckoutContinueAnswer);
  }

  return {
    codeStep,
    codeStart: startRoute,
    codeResend: resendRoute,
    codeVerify: verifyRoute,
    codePay: payRoute,
    checkoutContinue: continueRoute,
    checkoutContinueFor,
    clearCookies: () => [clearTicket(), clearProof()],
  };
}
