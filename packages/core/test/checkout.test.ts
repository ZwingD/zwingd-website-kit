/**
 * Member checkout (session hand-over v1.1, "Member checkout"): the website's
 * own POST /session/checkout and the server quote, against a fake API that
 * answers the two C4 calls.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  CHECKOUT_PATH,
  CHECKOUT_QUOTE_TIMEOUT_MS,
  CHECKOUT_RETURN_PATH,
  CHECKOUT_START_TIMEOUT_MS,
  createMemberCheckout,
} from "../src/checkout.ts";
import { createWebsiteKit } from "../src/flows.ts";
import { API, APP, ORIGIN, req, SECRET, TOKEN } from "./helpers.ts";

const OFFER = "6520f1c2a3b4c5d6e7f80a01";
const GATEWAY = "6520f1c2a3b4c5d6e7f80c03";
const COUNTRY = "6520f1c2a3b4c5d6e7f80b02";
const ORDER = "6520f1c2a3b4c5d6e7f80d04";
const ORDER_TOKEN = "ot_order_read_token_never_logged_0123456789";
const CSRF = "c".repeat(43);
const QUOTE = {
  offer: OFFER,
  currencyCode: "USD",
  minorUnitExponent: 2,
  totalMinor: "227900",
  subTotalMinor: "227900",
  discountTotalMinor: "0",
  taxTotalMinor: "0",
  pricesIncludeTax: false,
  alreadyEnrolled: false,
  gateways: [{ paymentGateway: GATEWAY, name: "Card" }],
};
const SESSION = {
  orderId: ORDER,
  paymentState: "PENDING",
  redirectUrl: "https://pay.example.org/c/pay/cs_test_a1b2c3",
  resumed: false,
  orderToken: ORDER_TOKEN,
  orderTokenExpiresAt: "2026-10-29T10:00:00.000Z",
};

type Reply = { status: number; body?: unknown } | "timeout" | "network";
interface Call {
  call: "quote" | "start";
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/** A fetch answering `checkout/quote` and `checkout/start` from lists of replies, recording each call. */
function fakeCheckoutApi(replies: { quote?: Reply[]; start?: Reply[] }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call = url.endsWith("/checkout/quote") ? "quote" : url.endsWith("/checkout/start") ? "start" : null;
    if (!call) throw new Error(`unexpected call ${url}`);
    calls.push({ call, url, authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    const reply = replies[call]?.[calls.filter((c) => c.call === call).length - 1];
    if (reply === undefined) throw new Error(`no reply configured for ${call}`);
    if (reply === "network") throw new TypeError(`fetch failed ${SECRET} ${TOKEN}`);
    if (reply === "timeout") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function setup(replies: { quote?: Reply[]; start?: Reply[] }, options: Parameters<typeof createMemberCheckout>[1] = {}) {
  const api = fakeCheckoutApi(replies);
  const kit = createWebsiteKit({ apiUrl: API, appUrl: APP, realm: "acme", clientSecret: SECRET, origin: ORIGIN, fetch: api.fetch });
  const checkout = createMemberCheckout(kit, { quoteTimeoutMs: 50, startTimeoutMs: 50, ...options });
  return { api, kit, checkout };
}

const SIGNED_IN = { "__Host-zw_session": TOKEN, "__Host-zw_csrf": CSRF };
const form = (over: Record<string, string> = {}) => ({ csrf: CSRF, offer: OFFER, expectedTotalMinor: "227900", paymentGateway: GATEWAY, ...over });
const post = (over: Partial<Parameters<typeof req>[0]> = {}) =>
  req({
    method: "POST",
    url: `${ORIGIN}${CHECKOUT_PATH}`,
    cookies: SIGNED_IN,
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
    form: form(),
    ...over,
  });
const answerOf = (res: { body: string }) => JSON.parse(res.body);
const ok = (body: unknown): Reply => ({ status: 200, body });
const refused = (reason: string): Reply => ({ status: 409, body: { error: "checkout_refused", reason } });

// No log line of any kind, ever: the kit never logs, so nothing can carry a secret or a token.
const consoleCalls: unknown[][] = [];
const originals: Partial<Record<keyof Console, unknown>> = {};
beforeEach(() => {
  consoleCalls.length = 0;
  for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    originals[name] = console[name];
    console[name] = (...args: unknown[]) => void consoleCalls.push(args);
  }
});
afterEach(() => {
  for (const [name, fn] of Object.entries(originals)) (console as unknown as Record<string, unknown>)[name] = fn;
  assert.deepEqual(consoleCalls, [], "the kit logged something");
});

test("the timeouts are the contract's: 10 s for a quote, 30 s for a start", () => {
  assert.equal(CHECKOUT_QUOTE_TIMEOUT_MS, 10_000);
  assert.equal(CHECKOUT_START_TIMEOUT_MS, 30_000);
  assert.equal(CHECKOUT_PATH, "/session/checkout");
  assert.equal(CHECKOUT_RETURN_PATH, "/checkout/return");
});

test("GET /session/checkout is 405 Allow: POST, and nothing is asked of the API", async () => {
  const { api, checkout } = setup({});
  for (const method of ["GET", "HEAD", "PUT"]) {
    const res = await checkout.checkout(post({ method }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.Allow, "POST");
  }
  assert.equal(api.calls.length, 0);
});

test("cross-site requests and a missing or wrong CSRF value are 403 with the same check as /session/end", async () => {
  const { api, checkout } = setup({});
  for (const view of [
    post({ headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }),
    post({ headers: { origin: "https://evil.example" } }),
    post({ headers: { "sec-fetch-site": "cross-site" } }),
    post({ headers: { "sec-fetch-site": "same-site" } }),
    post({ form: form({ csrf: "" }) }),
    post({ form: form({ csrf: "d".repeat(43) }) }),
    post({ cookies: { "__Host-zw_session": TOKEN } }),
    post({ cookies: { "__Host-zw_session": TOKEN, "__Host-zw_csrf": "short" }, form: form({ csrf: "short" }) }),
  ]) {
    const res = await checkout.checkout(view);
    assert.equal(res.status, 403);
    assert.equal(res.headers["Cache-Control"], "no-store");
  }
  assert.equal(api.calls.length, 0);
});

test("a malformed request is 400 and asks nothing", async () => {
  const { api, checkout } = setup({});
  for (const bad of [{ offer: "not-an-id" }, { offer: "" }, { expectedTotalMinor: "12.50" }, { expectedTotalMinor: "" }]) {
    const res = await checkout.checkout(post({ form: form(bad) }));
    assert.equal(res.status, 400);
    assert.deepEqual(answerOf(res), { kind: "fallback", reason: "invalid-request" });
  }
  assert.equal(api.calls.length, 0);
});

test("no session cookie: fallback signed-out, and the API is never asked", async () => {
  const { api, checkout } = setup({});
  const res = await checkout.checkout(post({ cookies: { "__Host-zw_csrf": CSRF } }));
  assert.equal(res.status, 200);
  assert.deepEqual(answerOf(res), { kind: "fallback", reason: "signed-out" });
  assert.equal(api.calls.length, 0);
});

test("the start sends the site's own returnUrl, never one from the browser, with the secret in the header only", async () => {
  const { api, checkout } = setup({ start: [ok(SESSION)] });
  await checkout.checkout(post({ form: form({ returnUrl: "https://evil.example/steal", origin: "https://evil.example", realm: "other", visitorCountry: COUNTRY }) }));
  assert.equal(api.calls.length, 1);
  const [call] = api.calls;
  assert.equal(call!.url, `${API}/api/external/session-handover/checkout/start`);
  assert.equal(call!.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(call!.body, {
    realm: "acme",
    origin: ORIGIN,
    sessionToken: TOKEN,
    offer: OFFER,
    paymentGateway: GATEWAY,
    expectedTotalMinor: "227900",
    returnUrl: `${ORIGIN}/checkout/return`,
  });
  assert.equal(JSON.stringify(call!.body).includes(SECRET), false);
});

test("visitorCountry comes from the site's resolver only; a malformed value is left out", async () => {
  const seen: string[] = [];
  const { api, checkout } = setup(
    { start: [ok(SESSION), ok(SESSION)] },
    { visitorCountry: (view) => (seen.push(view.headers["x-country"] ?? ""), view.headers["x-country"] === "IN" ? COUNTRY : "IN") }
  );
  await checkout.checkout(post({ headers: { origin: ORIGIN, "x-country": "IN" } }));
  await checkout.checkout(post({ headers: { origin: ORIGIN, "x-country": "XX" } }));
  assert.equal(api.calls[0]!.body.visitorCountry, COUNTRY);
  assert.equal("visitorCountry" in api.calls[1]!.body, false);
  assert.deepEqual(seen, ["IN", "XX"]);
});

test("attribution: only the six keys go on, cut to 200 characters", async () => {
  const { api, checkout } = setup({ start: [ok(SESSION)] });
  await checkout.checkout(post({ form: form({ utmSource: "news", gclid: "g".repeat(250), referrer: "dropped" }) }));
  assert.deepEqual(api.calls[0]!.body.attribution, { utmSource: "news", gclid: "g".repeat(200) });
});

test("ok: redirect to the payment page with the order id and order token", async () => {
  const { checkout } = setup({ start: [ok(SESSION)] });
  const res = await checkout.checkout(post());
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(answerOf(res), {
    kind: "redirect",
    url: SESSION.redirectUrl,
    orderId: ORDER,
    orderToken: ORDER_TOKEN,
    orderTokenExpiresAt: SESSION.orderTokenExpiresAt,
    resumed: false,
  });
});

test("ok with no payment (a zero total): redirect straight to the site's return page for the order", async () => {
  const { checkout } = setup({ start: [ok({ ...SESSION, redirectUrl: null, paymentState: "PAID" })] });
  assert.equal(answerOf(await checkout.checkout(post())).url, `${ORIGIN}/checkout/return/${ORDER}`);
});

test("an answer that does not have C3's shape is unavailable, never a redirect", async () => {
  for (const body of [{ ...SESSION, orderId: "x" }, { ...SESSION, redirectUrl: "javascript:alert(1)" }, {}]) {
    const { checkout } = setup({ start: [ok(body)] });
    assert.deepEqual(answerOf(await checkout.checkout(post())), { kind: "fallback", reason: "unavailable" });
  }
});

test("404 (an API without member checkout): fallback not-available", async () => {
  const { checkout } = setup({ start: [{ status: 404, body: { error: "invalid_request" } }] });
  assert.deepEqual(answerOf(await checkout.checkout(post())), { kind: "fallback", reason: "not-available" });
});

test("login_required: the session cookie is cleared and the answer is fallback signed-out", async () => {
  const { checkout } = setup({ start: [{ status: 403, body: { error: "login_required" } }] });
  const res = await checkout.checkout(post());
  assert.deepEqual(answerOf(res), { kind: "fallback", reason: "signed-out" });
  const cleared = res.setCookies.find((line) => line.startsWith("__Host-zw_session="));
  assert.ok(cleared && /Max-Age=0/.test(cleared) && /Secure/.test(cleared) && /Path=\//.test(cleared));
});

test("checkout_refused WEBSITE_CHECKOUT_DISABLED: fallback checkout-disabled", async () => {
  const { checkout } = setup({ start: [refused("WEBSITE_CHECKOUT_DISABLED")] });
  assert.deepEqual(answerOf(await checkout.checkout(post())), { kind: "fallback", reason: "checkout-disabled" });
});

test("checkout_refused ALREADY_ENROLLED: already-owned", async () => {
  const { checkout } = setup({ start: [refused("ALREADY_ENROLLED")] });
  assert.deepEqual(answerOf(await checkout.checkout(post())), { kind: "already-owned" });
});

test("PRICE_CHANGED: one re-quote, no second start, then fallback price-changed with the new quote to show", async () => {
  const { api, checkout } = setup({ start: [refused("PRICE_CHANGED")], quote: [ok({ ...QUOTE, totalMinor: "199900" })] });
  const answer = answerOf(await checkout.checkout(post()));
  assert.deepEqual(answer, { kind: "fallback", reason: "price-changed", quote: { ...QUOTE, totalMinor: "199900" } });
  assert.deepEqual(api.calls.map((c) => c.call), ["start", "quote"]);
  assert.deepEqual(api.calls[1]!.body, { realm: "acme", origin: ORIGIN, sessionToken: TOKEN, offer: OFFER });
});

test("PRICE_CHANGED with a re-quote that fails: fallback price-changed with no quote", async () => {
  const { api, checkout } = setup({ start: [refused("PRICE_CHANGED")], quote: [{ status: 503, body: { error: "unavailable" } }] });
  assert.deepEqual(answerOf(await checkout.checkout(post())), { kind: "fallback", reason: "price-changed" });
  assert.equal(api.calls.length, 2);
});

test("another refusal: fallback refused with its code; a code of the wrong shape is not passed on", async () => {
  const { checkout } = setup({ start: [refused("BUYER_NOT_ELIGIBLE")] });
  assert.deepEqual(answerOf(await checkout.checkout(post())), { kind: "fallback", reason: "refused", refusal: "BUYER_NOT_ELIGIBLE" });
  const odd = setup({ start: [refused("<script>")] });
  assert.deepEqual(answerOf(await odd.checkout.checkout(post())), { kind: "fallback", reason: "refused" });
});

test("a 503, a 429, a timeout or a network fault: fallback unavailable, and the start is NEVER retried", async () => {
  for (const reply of [{ status: 503, body: { error: "unavailable" } }, { status: 429, body: { error: "rate_limited" } }, "timeout", "network"] as Reply[]) {
    const { api, checkout } = setup({ start: [reply, ok(SESSION)] });
    const answer = answerOf(await checkout.checkout(post()));
    assert.deepEqual(answer, { kind: "fallback", reason: "unavailable" });
    assert.equal(api.calls.filter((c) => c.call === "start").length, 1);
    assert.equal(JSON.stringify(answer).includes(SECRET) || JSON.stringify(answer).includes(TOKEN), false);
  }
});

test("getMemberQuote: the member's quote from the server, with the visitor's country", async () => {
  const { api, checkout } = setup({ quote: [ok(QUOTE)] });
  const result = await checkout.getMemberQuote(SIGNED_IN, OFFER, { visitorCountry: COUNTRY });
  assert.deepEqual(result, { status: "ok", quote: QUOTE });
  assert.deepEqual(api.calls[0]!.body, { realm: "acme", origin: ORIGIN, sessionToken: TOKEN, offer: OFFER, visitorCountry: COUNTRY });
  assert.equal(api.calls[0]!.authorization, `Bearer ${SECRET}`);
});

test("getMemberQuote: signed-out, ended (login_required), not-available, refused, unavailable", async () => {
  assert.deepEqual(await setup({}).checkout.getMemberQuote({}, OFFER), { status: "signed-out" });
  assert.deepEqual(await setup({ quote: [{ status: 403, body: { error: "login_required" } }] }).checkout.getMemberQuote(SIGNED_IN, OFFER), {
    status: "ended",
  });
  assert.deepEqual(await setup({ quote: [{ status: 404 }] }).checkout.getMemberQuote(SIGNED_IN, OFFER), { status: "not-available" });
  assert.deepEqual(await setup({ quote: [refused("OFFER_NOT_FOUND")] }).checkout.getMemberQuote(SIGNED_IN, OFFER), {
    status: "refused",
    refusal: "OFFER_NOT_FOUND",
  });
  for (const reply of ["timeout", "network", { status: 200, body: { totalMinor: 5 } }] as Reply[]) {
    assert.deepEqual(await setup({ quote: [reply] }).checkout.getMemberQuote(SIGNED_IN, OFFER), { status: "unavailable" });
  }
  assert.deepEqual(await setup({}).checkout.getMemberQuote(SIGNED_IN, "not-an-id"), { status: "invalid-request" });
});

test("nothing thrown carries a secret or a token: a failing fetch is answered, never rethrown", async () => {
  const throwing = (async () => {
    throw new Error(`boom ${SECRET} ${TOKEN}`);
  }) as typeof fetch;
  const kit = createWebsiteKit({ apiUrl: API, appUrl: APP, realm: "acme", clientSecret: SECRET, origin: ORIGIN, fetch: throwing });
  const checkout = createMemberCheckout(kit);
  const res = await checkout.checkout(post());
  assert.equal(res.body.includes(SECRET) || res.body.includes(TOKEN), false);
  const quoted = await checkout.getMemberQuote(SIGNED_IN, OFFER);
  assert.equal(JSON.stringify(quoted).includes(SECRET), false);
});
