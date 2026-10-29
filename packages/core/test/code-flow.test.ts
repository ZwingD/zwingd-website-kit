/**
 * Checkout v3.2 code step against a fake API: /session/code-*, the proof
 * cookie, the re-quote and start with `checkoutProof` (A1, A2), and the
 * thank-you continue (A3). No session is ever made by the code step (D2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createWebsiteKit } from "../src/flows.ts";
import { API, APP, cookieNamed, jar, ORIGIN, req, SECRET, TOKEN } from "./helpers.ts";

const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const CSRF = "c".repeat(43);
const OFFER = "6520f1c2a3b4c5d6e7f80a01";
const GATEWAY = "6520f1c2a3b4c5d6e7f80a02";
const COUNTRY = "6520f1c2a3b4c5d6e7f80a03";
const ORDER = "6520f1c2a3b4c5d6e7f80a04";
const IP = "203.0.113.7";
const PROOF = "pf_" + "Q".repeat(43);
const NONCE = "n".repeat(43);
const CONTINUE_URL = `${APP}/session/checkout-continue`;
const TICKET = { ticketId: "tk_AbCdEf0123456789", codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: "2026-10-28T10:01:00.000Z" };
const VERIFIED = { proof: PROOF, proofExpiresInSeconds: 7200 };
const QUOTE = (totalMinor: string, alreadyEnrolled = false) => ({
  offer: OFFER,
  currencyCode: "USD",
  minorUnitExponent: 2,
  totalMinor,
  subTotalMinor: totalMinor,
  discountTotalMinor: "0",
  taxTotalMinor: "0",
  pricesIncludeTax: false,
  alreadyEnrolled,
  gateways: [{ paymentGateway: GATEWAY, name: "Stripe" }],
});
const STARTED = { orderId: ORDER, paymentState: "PENDING", redirectUrl: "https://checkout.stripe.com/c/pay/x", resumed: false, orderToken: "ot_1", orderTokenExpiresAt: "2026-10-28T12:00:00.000Z" };

type Reply = { status: number; body?: unknown } | "network";

function setup(replies: Record<string, Reply | Reply[]>, extra: { buyerIpFrom?: (h: Record<string, string | undefined>) => string | null; visitorCountry?: () => string | null } = {}) {
  const calls: { call: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call = url.slice(`${API}/api/external/session-handover/`.length);
    calls.push({ call, body: JSON.parse(String(init?.body ?? "{}")), authorization: new Headers(init?.headers).get("authorization") });
    const configured = replies[call];
    const reply = Array.isArray(configured) ? configured[calls.filter((c) => c.call === call).length - 1] : configured;
    if (reply === undefined) throw new Error(`no reply for ${call}`);
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  let now = NOW;
  const kit = createWebsiteKit({ apiUrl: API, appUrl: APP, realm: "acme", clientSecret: SECRET, origin: ORIGIN, fetch: fetchImpl, now: () => now, ...extra });
  return { kit, calls, setNow: (ms: number) => (now = ms) };
}

const post = (path: string, form: Record<string, string>, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  req({
    method: "POST",
    url: `${ORIGIN}${path}`,
    cookies: { "__Host-zw_csrf": CSRF, ...cookies },
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "x-forwarded-for": `198.51.100.99, ${IP}`, ...headers },
    form: { csrf: CSRF, ...form },
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(kit: ReturnType<typeof setup>["kit"], offer = OFFER) {
  const res = await kit.handle(post("/session/code-start", { email: " Buyer@Example.org ", offer }));
  assert.ok(res);
  return { res, cookies: jar(res.setCookies, { "__Host-zw_csrf": CSRF }) };
}

const START_OK = { "code/start": { status: 200, body: TICKET }, "checkout/drop-off": { status: 202 } } as const;

test("code-start: one start call with the buyer's IP and the site secret; the browser gets the times, never the ticket", async () => {
  const { kit, calls } = setup({ ...START_OK });
  const { res } = await started(kit);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(JSON.parse(res.body!), { codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: TICKET.resendAvailableAt });
  assert.ok(!res.body!.includes(TICKET.ticketId));
  assert.equal(calls[0]!.call, "code/start");
  assert.deepEqual(calls[0]!.body, { realm: "acme", origin: ORIGIN, email: "buyer@example.org", buyerIp: IP });
  assert.equal(calls[0]!.authorization, `Bearer ${SECRET}`);
  const ticket = cookieNamed(res.setCookies, "__Host-zw_ticket")!;
  assert.match(ticket, /HttpOnly/);
  assert.match(ticket, /Secure/);
  // A new ticket drops any proof from an earlier email (E4).
  assert.match(cookieNamed(res.setCookies, "__Host-zw_proof")!, /Max-Age=0/);
});

test("code-start reports only the drop-off stage code_sent, fire-and-forget (B5: identity records verified)", async () => {
  const { kit, calls } = setup({ "code/start": { status: 200, body: TICKET }, "checkout/drop-off": "network" });
  const { res } = await started(kit);
  assert.equal(res.status, 200);
  await flush();
  const drop = calls.find((c) => c.call === "checkout/drop-off");
  assert.deepEqual(drop?.body, { realm: "acme", origin: ORIGIN, email: "buyer@example.org", offer: OFFER, stage: "code_sent" });
});

test("code-start: a malformed email is refused locally with WEBSITE_CODE_EMAIL_INVALID", async () => {
  const { kit, calls } = setup({});
  const res = (await kit.handle(post("/session/code-start", { email: "not an email" })))!;
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body!), { reason: "WEBSITE_CODE_EMAIL_INVALID" });
  assert.equal(calls.length, 0);
});

test("code-start: the setting off is WEBSITE_CODE_DISABLED (409), passed on as is (E11)", async () => {
  const { kit } = setup({ "code/start": { status: 409, body: { statusCode: 409, reason: "WEBSITE_CODE_DISABLED", message: "x" } } });
  const res = (await kit.handle(post("/session/code-start", { email: "buyer@example.org" })))!;
  assert.equal(res.status, 409);
  assert.deepEqual(JSON.parse(res.body!), { reason: "WEBSITE_CODE_DISABLED" });
});

test("the code routes refuse a cross-site POST, a missing CSRF value and a GET; nothing reaches the API", async () => {
  const { kit, calls } = setup({});
  for (const path of ["/session/code-start", "/session/code-resend", "/session/code-verify", "/session/code-pay", "/session/checkout-continue"]) {
    assert.equal((await kit.handle(post(path, { email: "a@b.co" }, {}, { origin: "https://evil.example" })))!.status, 403, path);
    assert.equal((await kit.handle(post(path, { email: "a@b.co" }, {}, { "sec-fetch-site": "cross-site" })))!.status, 403, path);
    assert.equal((await kit.handle(post(path, { email: "a@b.co", csrf: "x".repeat(43) })))!.status, 403, path);
    assert.equal((await kit.handle(req({ url: `${ORIGIN}${path}` })))!.status, 405, path);
  }
  assert.equal(calls.length, 0);
});

test("the v3.1 app sign-in routes are gone (AC 17): /session/app and /session/app-code are not the kit's", async () => {
  const { kit } = setup({});
  assert.equal(await kit.handle(req({ url: `${ORIGIN}/session/app?to=%2F`, cookies: { "__Host-zw_session": TOKEN } })), null);
  assert.equal(await kit.handle(req({ url: `${ORIGIN}/session/app-code?state=${"s".repeat(43)}` })), null);
  const k = kit as unknown as Record<string, unknown>;
  for (const gone of ["app", "appCode", "isNewAccountBuyer"]) assert.equal(k[gone], undefined, gone);
});

test("refusals pass the reason, wait and fields on; never the API's sentence", async () => {
  const { kit } = setup({
    "code/start": { status: 429, body: { statusCode: 429, reason: "WEBSITE_CODE_RATE_LIMITED", message: "Slow down, buyer@example.org", retryAfterSeconds: 90 } },
  });
  const res = (await kit.handle(post("/session/code-start", { email: "buyer@example.org" })))!;
  assert.equal(res.status, 429);
  assert.deepEqual(JSON.parse(res.body!), { reason: "WEBSITE_CODE_RATE_LIMITED", retryAfterSeconds: 90 });
});

test("an API that cannot answer is UNAVAILABLE (503)", async () => {
  const { kit } = setup({ "code/start": "network" });
  const res = (await kit.handle(post("/session/code-start", { email: "buyer@example.org" })))!;
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.body!), { reason: "UNAVAILABLE" });
});

test("no buyer IP: the start is not sent", async () => {
  const { kit, calls } = setup({}, { buyerIpFrom: () => null });
  const res = (await kit.handle(post("/session/code-start", { email: "buyer@example.org" })))!;
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

test("buyerIpFrom: a site's own resolver is used, and a non-IP value is ignored", async () => {
  const { kit, calls } = setup({ "code/start": { status: 200, body: TICKET } }, { buyerIpFrom: (h) => h["x-real-ip"] ?? null });
  await kit.handle(post("/session/code-start", { email: "buyer@example.org" }, {}, { "x-real-ip": "2001:db8::1" }));
  assert.equal(calls[0]!.body.buyerIp, "2001:db8::1");
  const bad = setup({}, { buyerIpFrom: () => "evil; drop" });
  assert.equal((await bad.kit.handle(post("/session/code-start", { email: "buyer@example.org" })))!.status, 503);
});

test("buyerIp default: x-real-ip, else the LAST x-forwarded-for hop; a browser-sent first hop is never used (PR #17 review)", async () => {
  const { forwardedBuyerIp } = await import("../src/config.ts");
  assert.equal(forwardedBuyerIp({ "x-forwarded-for": "198.51.100.99, 203.0.113.7" }), "203.0.113.7");
  assert.equal(forwardedBuyerIp({ "x-real-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.99, 203.0.113.7" }), "203.0.113.8");
  assert.equal(forwardedBuyerIp({ "x-forwarded-for": "not-an-ip" }), null);
  assert.equal(forwardedBuyerIp({}), null);
});

test("code-resend uses the ticket from the cookie; no cookie at all is WEBSITE_CODE_EXPIRED", async () => {
  const { kit, calls } = setup({ ...START_OK, "code/resend": { status: 200, body: { ...TICKET, resendAvailableAt: "2026-10-28T10:02:00.000Z" } } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-resend", {}, cookies)))!;
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body!).resendAvailableAt, "2026-10-28T10:02:00.000Z");
  assert.deepEqual(calls.find((c) => c.call === "code/resend")!.body, { realm: "acme", origin: ORIGIN, ticketId: TICKET.ticketId, buyerIp: IP });

  const none = (await kit.handle(post("/session/code-resend", {})))!;
  assert.equal(none.status, 400);
  assert.deepEqual(JSON.parse(none.body!), { reason: "WEBSITE_CODE_EXPIRED" });
});

test("§8: an expired ticket's 'Send a new code' starts again with the stored email (no resend call)", async () => {
  const { kit, calls, setNow } = setup({
    "code/start": [{ status: 200, body: TICKET }, { status: 200, body: { ...TICKET, ticketId: "tk_second" } }],
    "checkout/drop-off": { status: 202 },
  });
  const { cookies } = await started(kit);
  setNow(NOW + 11 * 60_000);
  const res = (await kit.handle(post("/session/code-resend", {}, cookies)))!;
  assert.equal(res.status, 200);
  assert.equal(calls.filter((c) => c.call === "code/resend").length, 0);
  const restarts = calls.filter((c) => c.call === "code/start");
  assert.equal(restarts.length, 2);
  assert.deepEqual(restarts[1]!.body, { realm: "acme", origin: ORIGIN, email: "buyer@example.org", buyerIp: IP });
  assert.ok(cookieNamed(res.setCookies, "__Host-zw_ticket"));
});

test("§4.2: a resend the API calls WEBSITE_CODE_EXPIRED also starts again with the stored email", async () => {
  const { kit, calls } = setup({
    "code/start": [{ status: 200, body: TICKET }, { status: 200, body: TICKET }],
    "code/resend": { status: 400, body: { reason: "WEBSITE_CODE_EXPIRED" } },
    "checkout/drop-off": { status: 202 },
  });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-resend", {}, cookies)))!;
  assert.equal(res.status, 200);
  assert.equal(calls.filter((c) => c.call === "code/start").length, 2);
});

test("E5: the resend cap passes WEBSITE_CODE_LOCKED and its wait on", async () => {
  const { kit } = setup({ ...START_OK, "code/resend": { status: 429, body: { reason: "WEBSITE_CODE_LOCKED", retryAfterSeconds: 900 } } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-resend", {}, cookies)))!;
  assert.equal(res.status, 429);
  assert.deepEqual(JSON.parse(res.body!), { reason: "WEBSITE_CODE_LOCKED", retryAfterSeconds: 900 });
});

const PURCHASE = { offer: OFFER, expectedTotalMinor: "9900", paymentGateway: GATEWAY, utmSource: "news" };

test("code-verify, total unchanged: proof cookie (HttpOnly), NO session, re-quote and start with checkoutProof + buyerIp", async () => {
  const { kit, calls } = setup(
    { ...START_OK, "code/verify": { status: 200, body: VERIFIED }, "checkout/quote": { status: 200, body: QUOTE("9900") }, "checkout/start": { status: 200, body: STARTED } },
    { visitorCountry: () => COUNTRY },
  );
  const { cookies } = await started(kit);
  const res = (await kit.handle(
    post(
      "/session/code-verify",
      { code: "123 456", firstName: " Asha ", lastName: "", acceptedDocuments: JSON.stringify([{ type: "terms", version: 3, evil: "x" }]), ...PURCHASE },
      cookies,
    ),
  ))!;
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body!), {
    kind: "redirect",
    url: STARTED.redirectUrl,
    orderId: ORDER,
    orderToken: "ot_1",
    orderTokenExpiresAt: STARTED.orderTokenExpiresAt,
    settled: false,
  });
  // The proof never reaches the browser.
  assert.ok(!res.body!.includes(PROOF));
  const proof = cookieNamed(res.setCookies, "__Host-zw_proof")!;
  assert.match(proof, new RegExp(`^__Host-zw_proof=${PROOF};`));
  for (const attr of [/HttpOnly/, /Secure/, /SameSite=Lax/, /Path=\//, /Max-Age=9000/]) assert.match(proof, attr);
  // 7200 s of verify-time life + the 30 min the PAID extension can add (A7): a buyer who pays near the end keeps the button.
  // No account, no session (D2).
  assert.equal(cookieNamed(res.setCookies, "__Host-zw_session"), undefined);
  assert.equal(cookieNamed(res.setCookies, "__Host-zw_new"), undefined);
  assert.match(cookieNamed(res.setCookies, "__Host-zw_ticket")!, /Max-Age=0/);

  const verify = calls.find((c) => c.call === "code/verify")!.body;
  assert.deepEqual(verify, { realm: "acme", origin: ORIGIN, ticketId: TICKET.ticketId, code: "123456", buyerIp: IP, firstName: "Asha", acceptedDocuments: [{ type: "terms", version: "3" }] });
  const quote = calls.find((c) => c.call === "checkout/quote")!.body;
  assert.deepEqual(quote, { realm: "acme", origin: ORIGIN, checkoutProof: PROOF, buyerIp: IP, offer: OFFER, visitorCountry: COUNTRY });
  assert.ok(!("sessionToken" in quote));
  const start = calls.find((c) => c.call === "checkout/start")!.body;
  assert.deepEqual(start, {
    realm: "acme",
    origin: ORIGIN,
    checkoutProof: PROOF,
    buyerIp: IP,
    offer: OFFER,
    visitorCountry: COUNTRY,
    paymentGateway: GATEWAY,
    expectedTotalMinor: "9900",
    returnUrl: `${ORIGIN}/checkout/return`,
    attribution: { utmSource: "news" },
  });
  await flush();
  assert.equal(calls.filter((c) => c.call === "checkout/drop-off").length, 1, "only code_sent: identity records verified (B5)");
});

const PICKED = "6520f1c2a3b4c5d6e7f80a05";

test("country: the one the page priced in (picked ≠ geo) is quoted and started with; a non-member's same total goes straight to start", async () => {
  const { kit, calls } = setup(
    { ...START_OK, "code/verify": { status: 200, body: VERIFIED }, "checkout/quote": { status: 200, body: QUOTE("9900") }, "checkout/start": { status: 200, body: STARTED } },
    { visitorCountry: () => COUNTRY },
  );
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-verify", { code: "123456", ...PURCHASE, country: PICKED }, cookies)))!;
  assert.equal(JSON.parse(res.body!).kind, "redirect", "no false member-price line");
  assert.equal(calls.find((c) => c.call === "checkout/quote")!.body.visitorCountry, PICKED);
  assert.equal(calls.find((c) => c.call === "checkout/start")!.body.visitorCountry, PICKED);
});

test("country: none posted (or not an id) falls back to the kit's visitorCountry; neither gives none", async () => {
  const replies = { ...START_OK, "code/verify": { status: 200, body: VERIFIED }, "checkout/quote": { status: 200, body: QUOTE("9900") }, "checkout/start": { status: 200, body: STARTED } };
  for (const form of [{}, { country: "IN" }] as Record<string, string>[]) {
    const { kit, calls } = setup(replies, { visitorCountry: () => COUNTRY });
    const { cookies } = await started(kit);
    await kit.handle(post("/session/code-verify", { code: "123456", ...PURCHASE, ...form }, cookies));
    assert.equal(calls.find((c) => c.call === "checkout/quote")!.body.visitorCountry, COUNTRY, JSON.stringify(form));
    assert.equal(calls.find((c) => c.call === "checkout/start")!.body.visitorCountry, COUNTRY, JSON.stringify(form));
  }
  const bare = setup(replies);
  const { cookies } = await started(bare.kit);
  await bare.kit.handle(post("/session/code-verify", { code: "123456", ...PURCHASE }, cookies));
  assert.ok(!("visitorCountry" in bare.calls.find((c) => c.call === "checkout/quote")!.body));
});

test("country: 'Pay {amount}' starts in the posted country too", async () => {
  const { kit, calls } = setup({ "checkout/start": { status: 200, body: STARTED } }, { visitorCountry: () => COUNTRY });
  await kit.handle(post("/session/code-pay", { offer: OFFER, expectedTotalMinor: "7900", country: PICKED }, { "__Host-zw_proof": PROOF }));
  assert.equal(calls.find((c) => c.call === "checkout/start")!.body.visitorCountry, PICKED);
});

test("A2: a changed total (member price) is shown first: confirm-price, and NO start", async () => {
  const { kit, calls } = setup({ ...START_OK, "code/verify": { status: 200, body: VERIFIED }, "checkout/quote": { status: 200, body: QUOTE("7900") } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-verify", { code: "123456", ...PURCHASE }, cookies)))!;
  assert.deepEqual(JSON.parse(res.body!), { kind: "confirm-price", totalMinor: "7900", currencyCode: "USD", minorUnitExponent: 2 });
  assert.equal(calls.filter((c) => c.call === "checkout/start").length, 0);
  assert.ok(cookieNamed(res.setCookies, "__Host-zw_proof"));
});

test("A2: 'Pay {amount}' starts with the held proof at the shown total", async () => {
  const { kit, calls } = setup({ "checkout/start": { status: 200, body: STARTED } });
  const res = (await kit.handle(post("/session/code-pay", { offer: OFFER, expectedTotalMinor: "7900" }, { "__Host-zw_proof": PROOF })))!;
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body!).kind, "redirect");
  const start = calls.find((c) => c.call === "checkout/start")!.body;
  assert.equal(start.checkoutProof, PROOF);
  assert.equal(start.buyerIp, IP);
  assert.equal(start.expectedTotalMinor, "7900");
  assert.ok(!res.body!.includes(PROOF));
});

test("code-pay: PRICE_CHANGED quotes again ONCE and shows the new price; nothing started at it", async () => {
  const { kit, calls } = setup({
    "checkout/start": { status: 409, body: { error: "checkout_refused", reason: "PRICE_CHANGED" } },
    "checkout/quote": { status: 200, body: QUOTE("8900") },
  });
  const res = (await kit.handle(post("/session/code-pay", { offer: OFFER, expectedTotalMinor: "7900" }, { "__Host-zw_proof": PROOF })))!;
  assert.deepEqual(JSON.parse(res.body!), { kind: "confirm-price", totalMinor: "8900", currencyCode: "USD", minorUnitExponent: 2 });
  assert.equal(calls.filter((c) => c.call === "checkout/start").length, 1);
});

test("code-pay without a proof cookie, or a proof the API refuses, is payment-failed CHECKOUT_PROOF_INVALID and drops the cookie", async () => {
  const { kit, calls } = setup({ "checkout/start": { status: 409, body: { error: "checkout_refused", reason: "CHECKOUT_PROOF_INVALID" } } });
  const none = (await kit.handle(post("/session/code-pay", { offer: OFFER, expectedTotalMinor: "7900" })))!;
  assert.deepEqual(JSON.parse(none.body!), { kind: "payment-failed", reason: "CHECKOUT_PROOF_INVALID" });
  assert.equal(calls.length, 0);
  const refused = (await kit.handle(post("/session/code-pay", { offer: OFFER, expectedTotalMinor: "7900" }, { "__Host-zw_proof": PROOF })))!;
  assert.deepEqual(JSON.parse(refused.body!), { kind: "payment-failed", reason: "CHECKOUT_PROOF_INVALID" });
  assert.match(cookieNamed(refused.setCookies, "__Host-zw_proof")!, /Max-Age=0/);
});

test("code-verify: a quote that fails after a right code keeps the proof and answers payment-failed", async () => {
  const { kit } = setup({ ...START_OK, "code/verify": { status: 200, body: VERIFIED }, "checkout/quote": { status: 503, body: { error: "checkout_refused", reason: "CHECKOUT_PROOF_UNAVAILABLE" } } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-verify", { code: "123456", ...PURCHASE }, cookies)))!;
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body!), { kind: "payment-failed", reason: "CHECKOUT_PROOF_UNAVAILABLE" });
  assert.match(cookieNamed(res.setCookies, "__Host-zw_proof")!, new RegExp(`^__Host-zw_proof=${PROOF};`));
});

test("code-verify: already enrolled reads already-owned", async () => {
  const { kit } = setup({ ...START_OK, "code/verify": { status: 200, body: VERIFIED }, "checkout/quote": { status: 200, body: QUOTE("9900", true) } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-verify", { code: "123456", ...PURCHASE }, cookies)))!;
  assert.deepEqual(JSON.parse(res.body!), { kind: "already-owned" });
});

test("code-verify: an answer without a proof (or with v3.1 session fields only) is UNAVAILABLE; nothing is set", async () => {
  const { kit } = setup({ ...START_OK, "code/verify": { status: 200, body: { sessionToken: TOKEN, expiresAt: "2099-01-01T00:00:00.000Z", isNewAccount: true } } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-verify", { code: "123456", ...PURCHASE }, cookies)))!;
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.body!), { reason: "UNAVAILABLE" });
  assert.equal(res.setCookies.length, 0);
});

test("code-verify: a wrong code keeps the ticket; a code with no digits is refused without a call", async () => {
  const { kit, calls } = setup({ ...START_OK, "code/verify": { status: 400, body: { statusCode: 400, reason: "WEBSITE_CODE_INVALID", message: "x" } } });
  const { cookies } = await started(kit);
  const wrong = (await kit.handle(post("/session/code-verify", { code: "000000", ...PURCHASE }, cookies)))!;
  assert.equal(wrong.status, 400);
  assert.deepEqual(JSON.parse(wrong.body!), { reason: "WEBSITE_CODE_INVALID" });
  assert.equal(wrong.setCookies.length, 0);

  const before = calls.length;
  const letters = (await kit.handle(post("/session/code-verify", { code: "abcdef" }, cookies)))!;
  assert.deepEqual(JSON.parse(letters.body!), { reason: "WEBSITE_CODE_INVALID" });
  assert.equal(calls.length, before);
});

test("code-verify: an expired ticket is WEBSITE_CODE_EXPIRED and the ticket (with its email) is kept for the restart", async () => {
  const { kit, calls, setNow } = setup({ ...START_OK });
  const { cookies } = await started(kit);
  setNow(NOW + 11 * 60_000);
  const res = (await kit.handle(post("/session/code-verify", { code: "123456" }, cookies)))!;
  assert.deepEqual(JSON.parse(res.body!), { reason: "WEBSITE_CODE_EXPIRED" });
  assert.equal(res.setCookies.length, 0);
  assert.equal(calls.filter((c) => c.call === "code/verify").length, 0);
});

test("code-verify: terms required passes the fields on", async () => {
  const { kit } = setup({ ...START_OK, "code/verify": { status: 400, body: { statusCode: 400, reason: "WEBSITE_TERMS_REQUIRED", message: "x", fields: ["acceptedDocuments"] } } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-verify", { code: "123456" }, cookies)))!;
  assert.deepEqual(JSON.parse(res.body!), { reason: "WEBSITE_TERMS_REQUIRED", fields: ["acceptedDocuments"] });
});

test("GET /session/code-step: a form value for a signed-out visitor, and the open step after a reload", async () => {
  const { kit } = setup({ ...START_OK });
  const first = (await kit.handle(req({ url: `${ORIGIN}/session/code-step` })))!;
  assert.equal(first.status, 200);
  const read = JSON.parse(first.body!);
  assert.match(read.formToken, /^[A-Za-z0-9\-._~]{43}$/);
  assert.equal(read.pending, null);

  const { cookies } = await started(kit);
  const again = (await kit.handle(req({ url: `${ORIGIN}/session/code-step`, cookies })))!;
  assert.deepEqual(JSON.parse(again.body!), {
    formToken: CSRF,
    pending: { email: "buyer@example.org", codeLength: 6, codeExpiresAt: "2026-10-28T10:10:00.000Z", resendAvailableAt: TICKET.resendAvailableAt },
  });
  assert.ok(!again.body!.includes(TICKET.ticketId));
  assert.equal((await kit.handle(req({ url: `${ORIGIN}/session/code-step`, headers: { origin: "https://evil.example" } })))!.status, 403);
});

test("checkoutContinueFor: the server reads checkout-proof/context and gives the label only; no nonce is minted", async () => {
  const { kit, calls } = setup({ "checkout-proof/context": [{ status: 200, body: { continueAs: "sign-up", proofExpiresInSeconds: 1500 } }, { status: 200, body: { continueAs: "member", proofExpiresInSeconds: 1500 } }] });
  assert.deepEqual(await kit.checkoutContinueFor({ "__Host-zw_proof": PROOF }), { continueAs: "sign-up", label: "Continue sign-up", action: "/session/checkout-continue", signInUrl: `${APP}/` });
  assert.deepEqual(await kit.checkoutContinueFor({ "__Host-zw_proof": PROOF }), { continueAs: "member", label: "Go to my course", action: "/session/checkout-continue", signInUrl: `${APP}/` });
  assert.deepEqual(calls.map((c) => c.call), ["checkout-proof/context", "checkout-proof/context"]);
  assert.deepEqual(calls[0]!.body, { realm: "acme", origin: ORIGIN, proof: PROOF });
  assert.equal(await kit.checkoutContinueFor({}), null);
  assert.equal(calls.length, 2);
});

test("checkoutContinueFor: an invalid or expired proof is null", async () => {
  const { kit } = setup({ "checkout-proof/context": { status: 400, body: { reason: "CHECKOUT_PROOF_INVALID" } } });
  assert.equal(await kit.checkoutContinueFor({ "__Host-zw_proof": PROOF }), null);
});

test("A3: the press mints the nonce and answers { nonce, continueUrl } as JSON, no-store; never the proof", async () => {
  const { kit, calls } = setup({ "checkout-proof/continue": { status: 200, body: { nonce: NONCE, nonceExpiresInSeconds: 60, continueUrl: CONTINUE_URL, extra: "x" } } });
  const res = (await kit.handle(post("/session/checkout-continue", {}, { "__Host-zw_proof": PROOF }, { accept: "application/json" })))!;
  assert.equal(res.status, 200);
  assert.match(res.headers["Content-Type"]!, /^application\/json/);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  assert.deepEqual(JSON.parse(res.body!), { nonce: NONCE, continueUrl: CONTINUE_URL });
  assert.ok(!res.body!.includes(PROOF));
  assert.equal(res.headers.Location, undefined);
  assert.deepEqual(calls.map((c) => c.call), ["checkout-proof/continue"]);
  assert.deepEqual(calls[0]!.body, { realm: "acme", origin: ORIGIN, proof: PROOF });
  // The proof cookie stays: a second press reaches the app, which says the link has expired (U9a).
  assert.equal(res.setCookies.length, 0);
});

test("A3: no proof, an invalid proof, or a continueUrl that is not the app's continue route answers the app's normal sign-in", async () => {
  const none = setup({});
  const noProof = (await none.kit.handle(post("/session/checkout-continue", {})))!;
  assert.equal(noProof.status, 400);
  assert.deepEqual(JSON.parse(noProof.body!), { signInUrl: `${APP}/` });
  assert.equal(none.calls.length, 0);

  const invalid = setup({ "checkout-proof/continue": { status: 400, body: { reason: "CHECKOUT_PROOF_INVALID" } } });
  const bad = (await invalid.kit.handle(post("/session/checkout-continue", {}, { "__Host-zw_proof": PROOF })))!;
  assert.deepEqual(JSON.parse(bad.body!), { signInUrl: `${APP}/` });
  assert.match(cookieNamed(bad.setCookies, "__Host-zw_proof")!, /Max-Age=0/);

  for (const continueUrl of ["https://evil.example/collect", `${APP}/session/checkout-continue?nonce=x`, `http://app.example.org/session/checkout-continue`, "javascript:alert(1)"]) {
    const odd = setup({ "checkout-proof/continue": { status: 200, body: { nonce: NONCE, nonceExpiresInSeconds: 60, continueUrl } } });
    const r = (await odd.kit.handle(post("/session/checkout-continue", {}, { "__Host-zw_proof": PROOF })))!;
    assert.equal(r.status, 400, continueUrl);
    assert.deepEqual(JSON.parse(r.body!), { signInUrl: `${APP}/` }, continueUrl);
    assert.ok(!r.body!.includes(NONCE));
  }
});

test("end also clears the ticket and proof cookies", async () => {
  const { kit } = setup({ end: { status: 200, body: { ended: true, appSignOutUrl: null } } });
  const res = await kit.end(post("/session/end", {}, { "__Host-zw_session": TOKEN, "__Host-zw_proof": PROOF, "__Host-zw_ticket": "x" }));
  assert.equal(res.status, 303);
  assert.match(cookieNamed(res.setCookies, "__Host-zw_proof")!, /Max-Age=0/);
  assert.match(cookieNamed(res.setCookies, "__Host-zw_ticket")!, /Max-Age=0/);
});
