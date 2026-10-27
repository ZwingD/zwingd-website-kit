/**
 * Member checkout (session hand-over v1.1, "Member checkout"): a member signed
 * in on the website buys straight to payment, with no checkout pop-up and no
 * email to type.
 *
 *   POST /session/checkout   the browser's "Buy now". Same-site only, with the
 *                            SAME check as /session/end (no cross-site Origin
 *                            or Sec-Fetch-Site, and the `SameSite=Strict` CSRF
 *                            cookie's value in the form). Answers JSON.
 *   getMemberQuote(...)      the member's own price for one offer, on the
 *                            server, so the page shows what a start charges.
 *
 * The website's server calls the API (C4 `checkout/start` / `checkout/quote`)
 * with its client secret and the session token from the session cookie; the
 * browser never sends a token, a return address, a price it was not shown or
 * the visitor's country.
 *
 * ⛔ A start is never retried: it creates a payment. On PRICE_CHANGED the price
 * is quoted again ONCE and the new quote is handed back to show, but nothing is
 * started at a price the member has not seen.
 * ⛔ The kit logs nothing, and nothing thrown or answered carries the client
 * secret or the session token. The order token is answered to the browser that
 * paid, which keeps it in sessionStorage for the return page.
 *
 * The same-site rule is the kit's one rule (same-site.ts), shared with
 * POST /session/end.
 */
import {
  CHECKOUT_QUOTE_TIMEOUT_MS,
  CHECKOUT_START_TIMEOUT_MS,
  checkoutQuote,
  checkoutStart,
  isSessionToken,
  type CheckoutFailure,
  type MemberQuote,
  type MemberStartInput,
} from "./api-client.ts";
import type { RequestView, ResponseView, WebsiteKit } from "./flows.ts";
import { sameSitePost } from "./same-site.ts";

export { CHECKOUT_QUOTE_TIMEOUT_MS, CHECKOUT_START_TIMEOUT_MS } from "./api-client.ts";
export type { MemberQuote } from "./api-client.ts";

export const CHECKOUT_PATH = "/session/checkout";
/** The website's own return page; the buyer comes back to `<origin>/checkout/return/<orderId>`. */
export const CHECKOUT_RETURN_PATH = "/checkout/return";
/** The landing page's attribution the start forwards (C4); any other field is dropped. */
export const CHECKOUT_ATTRIBUTION_KEYS = ["utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm", "gclid"] as const;
export type CheckoutAttribution = Partial<Record<(typeof CHECKOUT_ATTRIBUTION_KEYS)[number], string>>;

/**
 * Why the website should use its own guest checkout instead:
 *   - `signed-out`: no session, or the API said it is over (the cookie is cleared);
 *   - `not-available`: this API has no member checkout (404);
 *   - `checkout-disabled`: the workspace has website checkout off;
 *   - `price-changed`: the price moved since the page was shown; `quote` holds the new one;
 *   - `refused`: another refusal, with its code in `refusal` when it has the contract's shape;
 *   - `unavailable`: the API could not answer (busy, down, a timeout);
 *   - `invalid-request`: the page sent a malformed request (a bug in the page).
 */
export type CheckoutFallbackReason =
  | "signed-out"
  | "not-available"
  | "checkout-disabled"
  | "price-changed"
  | "refused"
  | "unavailable"
  | "invalid-request";

export type MemberCheckoutAnswer =
  | {
      kind: "redirect";
      /** The payment page, or the site's return page when nothing was owed. */
      url: string;
      orderId: string;
      /** For #1866's return page: keep it in sessionStorage, never in an address. */
      orderToken: string | null;
      orderTokenExpiresAt: string | null;
      resumed: boolean;
      /**
       * True when nothing is owed: the order settled at once (a zero total) or an
       * earlier payment turned out paid. The member owns the offer now (kit #5).
       */
      settled: boolean;
    }
  /** `settled`: this start's order settled at once (a zero total), so it is the member's just now. */
  | { kind: "already-owned"; settled?: true }
  | { kind: "fallback"; reason: CheckoutFallbackReason; refusal?: string; quote?: MemberQuote };

export type MemberQuoteCheck =
  | { status: "ok"; quote: MemberQuote }
  | { status: "signed-out" }
  /** The API said the session is over: clear the session cookie (`kit.clearSessionCookie()`). */
  | { status: "ended" }
  | { status: "not-available" }
  | { status: "refused"; refusal?: string }
  | { status: "unavailable" }
  | { status: "invalid-request" };

/** The visitor's country as a master-data country id (24 hex), from the site's own source; null for none. */
export type VisitorCountryResolver = (req: RequestView) => string | null | undefined | Promise<string | null | undefined>;

export interface MemberCheckoutOptions {
  /** Where the visitor's country comes from (e.g. the host's geo header mapped to a country id). Never the request body. */
  visitorCountry?: VisitorCountryResolver;
  /** For tests: the call timeouts. Default the contract's 10 s and 30 s. */
  quoteTimeoutMs?: number;
  startTimeoutMs?: number;
}

export interface CheckoutResponseView extends ResponseView {
  body: string;
}

export interface MemberCheckout {
  /** `POST /session/checkout`. */
  checkout(req: RequestView): Promise<CheckoutResponseView>;
  /** The member's own quote for one offer, for the page to show. */
  getMemberQuote(cookies: Record<string, string>, offer: string, options?: { visitorCountry?: string | null; couponCode?: string }): Promise<MemberQuoteCheck>;
}

const OBJECT_ID = /^[0-9a-f]{24}$/;
const EXPECTED_TOTAL = /^\d{1,18}$/;
// eslint-disable-next-line no-control-regex
const COUPON = /^[^\u0000-\u001f\u007f]{1,64}$/;
const REASON = /^[A-Z][A-Z0-9_]*$/;
const ATTRIBUTION_MAX = 200;

const baseHeaders = (): Record<string, string> => ({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });

const id = (value: unknown): string | undefined => (typeof value === "string" && OBJECT_ID.test(value) ? value : undefined);

function attributionOf(form: Record<string, string>): CheckoutAttribution | undefined {
  const out: CheckoutAttribution = {};
  for (const key of CHECKOUT_ATTRIBUTION_KEYS) {
    const value = form[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim().slice(0, ATTRIBUTION_MAX);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createMemberCheckout(kit: WebsiteKit, options: MemberCheckoutOptions = {}): MemberCheckout {
  const { config, cookieNames: names } = kit;
  const quoteMs = options.quoteTimeoutMs ?? CHECKOUT_QUOTE_TIMEOUT_MS;
  const startMs = options.startTimeoutMs ?? CHECKOUT_START_TIMEOUT_MS;
  const returnUrl = `${config.origin}${CHECKOUT_RETURN_PATH}`;

  const json = (status: number, answer: MemberCheckoutAnswer | null, setCookies: string[] = []): CheckoutResponseView => ({
    status,
    headers: { ...baseHeaders(), ...(answer ? { "Content-Type": "application/json" } : {}) },
    setCookies,
    body: answer ? JSON.stringify(answer) : "",
  });
  const fallback = (reason: CheckoutFallbackReason, extra: { refusal?: string; quote?: MemberQuote } = {}): MemberCheckoutAnswer => ({
    kind: "fallback",
    reason,
    ...extra,
  });


  async function visitorCountryOf(req: RequestView): Promise<string | undefined> {
    if (!options.visitorCountry) return undefined;
    try {
      return id(await options.visitorCountry(req));
    } catch {
      return undefined;
    }
  }

  /** The session is over on the API: drop the cookie and the cached check. */
  async function ended(token: string): Promise<string[]> {
    await kit.forget(token);
    return [kit.clearSessionCookie()];
  }

  /** A refusal the member checkout does not act on, and every fault, as the page's answer. */
  function failureAnswer(error: CheckoutFailure, reason: string | undefined): MemberCheckoutAnswer {
    if (error === "not_available") return fallback("not-available");
    if (error === "checkout_refused") {
      if (reason === "WEBSITE_CHECKOUT_DISABLED") return fallback("checkout-disabled");
      if (reason === "ALREADY_ENROLLED") return { kind: "already-owned" };
      return fallback("refused", reason && REASON.test(reason) ? { refusal: reason } : {});
    }
    return fallback("unavailable");
  }

  async function checkout(req: RequestView): Promise<CheckoutResponseView> {
    if (req.method !== "POST") return { ...json(405, null), headers: { ...baseHeaders(), Allow: "POST" } };
    if (!sameSitePost(req, { origin: config.origin, csrfCookie: names.csrf })) return json(403, null);

    const form = req.form ?? {};
    const offer = id(form.offer);
    const expectedTotalMinor = typeof form.expectedTotalMinor === "string" && EXPECTED_TOTAL.test(form.expectedTotalMinor) ? form.expectedTotalMinor : null;
    const couponCode = typeof form.couponCode === "string" && form.couponCode !== "" ? form.couponCode : undefined;
    if (!offer || !expectedTotalMinor || (couponCode !== undefined && !COUPON.test(couponCode))) {
      return json(400, fallback("invalid-request"));
    }

    const token = req.cookies[names.session];
    if (!isSessionToken(token)) return json(200, fallback("signed-out"));

    const visitorCountry = await visitorCountryOf(req);
    const input: MemberStartInput = {
      offer,
      ...(couponCode ? { couponCode } : {}),
      ...(id(form.paymentGateway) ? { paymentGateway: form.paymentGateway } : {}),
      expectedTotalMinor,
      ...(visitorCountry ? { visitorCountry } : {}),
      // Always the site's own return page: never an address from the browser.
      returnUrl,
      ...(attributionOf(form) ? { attribution: attributionOf(form) as Record<string, string> } : {}),
    };

    // ONE start. Whatever it answers, it is not sent again.
    const started = await checkoutStart(config, token, input, startMs);
    if (started.ok) {
      const session = started.body;
      return json(200, {
        kind: "redirect",
        url: session.redirectUrl ?? `${returnUrl}/${session.orderId}`,
        orderId: session.orderId,
        orderToken: session.orderToken,
        orderTokenExpiresAt: session.orderTokenExpiresAt,
        resumed: session.resumed,
        settled: session.redirectUrl === null || session.paymentState === "PAID",
      });
    }
    if (started.error === "login_required") return json(200, fallback("signed-out"), await ended(token));
    if (started.error === "checkout_refused" && started.reason === "PRICE_CHANGED") {
      // Quoted again ONCE, so the page can show the new price; nothing is started at it here.
      const requoted = await checkoutQuote(
        config,
        token,
        { offer, ...(couponCode ? { couponCode } : {}), ...(visitorCountry ? { visitorCountry } : {}) },
        quoteMs
      );
      if (requoted.ok && requoted.body.alreadyEnrolled) return json(200, { kind: "already-owned" });
      if (!requoted.ok && requoted.error === "login_required") return json(200, fallback("signed-out"), await ended(token));
      return json(200, fallback("price-changed", requoted.ok ? { quote: requoted.body } : {}));
    }
    return json(200, failureAnswer(started.error, started.reason));
  }

  async function getMemberQuote(
    cookies: Record<string, string>,
    offer: string,
    quoteOptions: { visitorCountry?: string | null; couponCode?: string } = {}
  ): Promise<MemberQuoteCheck> {
    if (!id(offer)) return { status: "invalid-request" };
    const token = cookies[names.session];
    if (!isSessionToken(token)) return { status: "signed-out" };
    const visitorCountry = id(quoteOptions.visitorCountry);
    const couponCode = typeof quoteOptions.couponCode === "string" && COUPON.test(quoteOptions.couponCode) ? quoteOptions.couponCode : undefined;
    const res = await checkoutQuote(config, token, { offer, ...(couponCode ? { couponCode } : {}), ...(visitorCountry ? { visitorCountry } : {}) }, quoteMs);
    if (res.ok) return { status: "ok", quote: res.body };
    if (res.error === "login_required") {
      await kit.forget(token);
      return { status: "ended" };
    }
    if (res.error === "not_available") return { status: "not-available" };
    if (res.error === "checkout_refused") return { status: "refused", ...(res.reason ? { refusal: res.reason } : {}) };
    return { status: "unavailable" };
  }

  return { checkout, getMemberQuote };
}
