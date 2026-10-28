/**
 * Checkout v3.1 code step and app link against a fake API: /session/code-*,
 * /session/app and /session/app-code (spec §4, §6, §6.5; plan K1-K4, §14 X2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { appLinkHref } from "../src/code-routes.ts";
import { createWebsiteKit } from "../src/flows.ts";
import { API, APP, cookieNamed, jar, ORIGIN, req, SECRET, TOKEN } from "./helpers.ts";

const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const EXPIRES = "2026-10-28T18:00:00.000Z";
const CSRF = "c".repeat(43);
const OFFER = "6520f1c2a3b4c5d6e7f80a01";
const IP = "203.0.113.7";
const TICKET = { ticketId: "tk_AbCdEf0123456789", codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: "2026-10-28T10:01:00.000Z" };
const VERIFIED = (isNewAccount: boolean) => ({ sessionToken: TOKEN, expiresAt: EXPIRES, member: { firstName: "Asha", lastName: null }, isNewAccount });

type Reply = { status: number; body?: unknown } | "network";

function setup(replies: Record<string, Reply>, extra: { appSignIn?: boolean; buyerIpFrom?: (h: Record<string, string | undefined>) => string | null } = {}) {
  const calls: { call: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call = url.slice(`${API}/api/external/session-handover/`.length);
    calls.push({ call, body: JSON.parse(String(init?.body ?? "{}")), authorization: new Headers(init?.headers).get("authorization") });
    const reply = replies[call];
    if (reply === undefined) throw new Error(`no reply for ${call}`);
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const kit = createWebsiteKit({ apiUrl: API, appUrl: APP, realm: "acme", clientSecret: SECRET, origin: ORIGIN, fetch: fetchImpl, now: () => NOW, ...extra });
  return { kit, calls };
}

const post = (path: string, form: Record<string, string>, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  req({
    method: "POST",
    url: `${ORIGIN}${path}`,
    cookies: { "__Host-zw_csrf": CSRF, ...cookies },
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "x-forwarded-for": `${IP}, 10.0.0.1`, ...headers },
    form: { csrf: CSRF, ...form },
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(kit: ReturnType<typeof setup>["kit"], offer = OFFER) {
  const res = await kit.handle(post("/session/code-start", { email: " Buyer@Example.org ", offer }));
  assert.ok(res);
  return { res, cookies: jar(res.setCookies, { "__Host-zw_csrf": CSRF }) };
}

test("code-start: one start call with the buyer's IP and the site secret; the browser gets the times, never the ticket", async () => {
  const { kit, calls } = setup({ "code/start": { status: 200, body: TICKET }, "checkout/drop-off": { status: 202 } });
  const { res } = await started(kit);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  const body = JSON.parse(res.body!);
  assert.deepEqual(body, { codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: TICKET.resendAvailableAt });
  assert.ok(!res.body!.includes(TICKET.ticketId));
  assert.equal(calls[0]!.call, "code/start");
  assert.deepEqual(calls[0]!.body, { realm: "acme", origin: ORIGIN, email: "buyer@example.org", buyerIp: IP });
  assert.equal(calls[0]!.authorization, `Bearer ${SECRET}`);
  const ticket = cookieNamed(res.setCookies, "__Host-zw_ticket")!;
  assert.match(ticket, /HttpOnly/);
  assert.match(ticket, /Secure/);
  assert.match(ticket, /Max-Age=600/);
});

test("code-start reports the drop-off stage code_sent, fire-and-forget", async () => {
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

test("the code routes refuse a cross-site POST, a missing CSRF value and a GET; nothing reaches the API", async () => {
  const { kit, calls } = setup({});
  for (const path of ["/session/code-start", "/session/code-resend", "/session/code-verify"]) {
    assert.equal((await kit.handle(post(path, { email: "a@b.co" }, {}, { origin: "https://evil.example" })))!.status, 403);
    assert.equal((await kit.handle(post(path, { email: "a@b.co" }, {}, { "sec-fetch-site": "cross-site" })))!.status, 403);
    assert.equal((await kit.handle(post(path, { email: "a@b.co", csrf: "x".repeat(43) })))!.status, 403);
    assert.equal((await kit.handle(req({ url: `${ORIGIN}${path}` })))!.status, 405);
  }
  assert.equal(calls.length, 0);
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

test("code-resend uses the ticket from the cookie; no cookie is WEBSITE_CODE_EXPIRED", async () => {
  const { kit, calls } = setup({ "code/start": { status: 200, body: TICKET }, "code/resend": { status: 200, body: { ...TICKET, resendAvailableAt: "2026-10-28T10:02:00.000Z" } }, "checkout/drop-off": { status: 202 } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-resend", {}, cookies)))!;
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body!).resendAvailableAt, "2026-10-28T10:02:00.000Z");
  assert.deepEqual(calls.find((c) => c.call === "code/resend")!.body, { realm: "acme", origin: ORIGIN, ticketId: TICKET.ticketId, buyerIp: IP });

  const none = (await kit.handle(post("/session/code-resend", {})))!;
  assert.equal(none.status, 400);
  assert.deepEqual(JSON.parse(none.body!), { reason: "WEBSITE_CODE_EXPIRED" });
});

test("code-verify (new account): sets session, csrf and __Host-zw_new; the body never has isNewAccount", async () => {
  const { kit, calls } = setup({ "code/start": { status: 200, body: TICKET }, "code/verify": { status: 200, body: VERIFIED(true) }, "checkout/drop-off": { status: 202 } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(
    post("/session/code-verify", { code: "123456", firstName: " Asha ", lastName: "", acceptedDocuments: JSON.stringify([{ type: "terms", version: 3, evil: "x" }]) }, cookies),
  ))!;
  assert.equal(res.status, 200);
  assert.ok(!res.body!.includes("isNewAccount"));
  assert.ok(!res.body!.includes(TOKEN));
  assert.deepEqual(JSON.parse(res.body!), { member: { firstName: "Asha" }, notice: "account-ready", signOutToken: CSRF });

  const session = cookieNamed(res.setCookies, "__Host-zw_session")!;
  assert.match(session, new RegExp(`^__Host-zw_session=${TOKEN};`));
  assert.match(session, /HttpOnly/);
  assert.match(cookieNamed(res.setCookies, "__Host-zw_csrf")!, new RegExp(`^__Host-zw_csrf=${CSRF};.*SameSite=Strict`));
  const fresh = cookieNamed(res.setCookies, "__Host-zw_new")!;
  assert.match(fresh, /^__Host-zw_new=1;/);
  assert.match(fresh, /HttpOnly/);
  assert.match(fresh, /SameSite=Lax/);
  assert.match(fresh, /Secure/);
  assert.match(cookieNamed(res.setCookies, "__Host-zw_ticket")!, /Max-Age=0/);

  const sent = calls.find((c) => c.call === "code/verify")!.body;
  assert.deepEqual(sent, { realm: "acme", origin: ORIGIN, ticketId: TICKET.ticketId, code: "123456", buyerIp: IP, firstName: "Asha", acceptedDocuments: [{ type: "terms", version: "3" }] });
  await flush();
  assert.equal(calls.filter((c) => c.call === "checkout/drop-off").at(-1)!.body.stage, "verified");

  const after = jar(res.setCookies, cookies);
  assert.equal(kit.isNewAccountBuyer(after), true);
});

test("code-verify (existing member): no account-ready notice, and __Host-zw_new is cleared", async () => {
  const { kit } = setup({ "code/start": { status: 200, body: TICKET }, "code/verify": { status: 200, body: VERIFIED(false) }, "checkout/drop-off": { status: 202 } });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-verify", { code: "123456" }, { ...cookies, "__Host-zw_new": "1" })))!;
  assert.equal(JSON.parse(res.body!).notice, null);
  assert.ok(!res.body!.includes("isNewAccount"));
  assert.match(cookieNamed(res.setCookies, "__Host-zw_new")!, /Max-Age=0/);
  assert.equal(kit.isNewAccountBuyer(jar(res.setCookies, cookies)), false);
});

test("code-verify: a wrong code keeps the ticket; a non-digit code is refused without a call", async () => {
  const { kit, calls } = setup({
    "code/start": { status: 200, body: TICKET },
    "code/verify": { status: 400, body: { statusCode: 400, reason: "WEBSITE_CODE_INVALID", message: "x" } },
    "checkout/drop-off": { status: 202 },
  });
  const { cookies } = await started(kit);
  const wrong = (await kit.handle(post("/session/code-verify", { code: "000000" }, cookies)))!;
  assert.equal(wrong.status, 400);
  assert.deepEqual(JSON.parse(wrong.body!), { reason: "WEBSITE_CODE_INVALID" });
  assert.equal(cookieNamed(wrong.setCookies, "__Host-zw_ticket"), undefined);
  assert.equal(cookieNamed(wrong.setCookies, "__Host-zw_session"), undefined);

  const before = calls.length;
  const letters = (await kit.handle(post("/session/code-verify", { code: "12a456" }, cookies)))!;
  assert.deepEqual(JSON.parse(letters.body!), { reason: "WEBSITE_CODE_INVALID" });
  assert.equal(calls.length, before);
});

test("code-verify: terms required passes the fields on", async () => {
  const { kit } = setup({
    "code/start": { status: 200, body: TICKET },
    "code/verify": { status: 400, body: { statusCode: 400, reason: "WEBSITE_TERMS_REQUIRED", message: "x", fields: ["acceptedDocuments"] } },
    "checkout/drop-off": { status: 202 },
  });
  const { cookies } = await started(kit);
  const res = (await kit.handle(post("/session/code-verify", { code: "123456" }, cookies)))!;
  assert.deepEqual(JSON.parse(res.body!), { reason: "WEBSITE_TERMS_REQUIRED", fields: ["acceptedDocuments"] });
});

test("GET /session/code-step: a form value for a signed-out visitor, and the open step after a reload", async () => {
  const { kit } = setup({ "code/start": { status: 200, body: TICKET }, "checkout/drop-off": { status: 202 } });
  const first = (await kit.handle(req({ url: `${ORIGIN}/session/code-step` })))!;
  assert.equal(first.status, 200);
  const read = JSON.parse(first.body!);
  assert.match(read.formToken, /^[A-Za-z0-9\-._~]{43}$/);
  assert.equal(read.pending, null);
  assert.match(cookieNamed(first.setCookies, "__Host-zw_csrf")!, new RegExp(`^__Host-zw_csrf=${read.formToken};`));

  const { cookies } = await started(kit);
  const again = (await kit.handle(req({ url: `${ORIGIN}/session/code-step`, cookies })))!;
  assert.deepEqual(JSON.parse(again.body!), {
    formToken: CSRF,
    pending: { email: "buyer@example.org", codeLength: 6, codeExpiresAt: "2026-10-28T10:10:00.000Z", resendAvailableAt: TICKET.resendAvailableAt },
  });
  assert.ok(!again.body!.includes(TICKET.ticketId));
  assert.equal((await kit.handle(req({ url: `${ORIGIN}/session/code-step`, headers: { origin: "https://evil.example" } })))!.status, 403);
});

test("end also clears __Host-zw_new and the ticket cookie", async () => {
  const { kit } = setup({ end: { status: 200, body: { ended: true, appSignOutUrl: null } } });
  const res = await kit.end(post("/session/end", {}, { "__Host-zw_session": TOKEN, "__Host-zw_new": "1", "__Host-zw_ticket": "x" }));
  assert.equal(res.status, 303);
  assert.match(cookieNamed(res.setCookies, "__Host-zw_new")!, /Max-Age=0/);
  assert.match(cookieNamed(res.setCookies, "__Host-zw_ticket")!, /Max-Age=0/);
});

test("isNewAccountBuyer needs both the flag and a session", () => {
  const { kit } = setup({});
  assert.equal(kit.isNewAccountBuyer({ "__Host-zw_new": "1" }), false);
  assert.equal(kit.isNewAccountBuyer({ "__Host-zw_session": TOKEN }), false);
  assert.equal(kit.isNewAccountBuyer({ "__Host-zw_new": "1", "__Host-zw_session": TOKEN }), true);
});

test("appLinkHref keeps the target under the saved-path rule", () => {
  assert.equal(appLinkHref("/onboarding/profile"), "/session/app?to=%2Fonboarding%2Fprofile");
  assert.equal(appLinkHref("//evil.example"), "/session/app?to=%2F");
  assert.equal(appLinkHref("https://evil.example"), "/session/app?to=%2F");
});

test("/session/app: appSignIn on and signed in, 303 to the app's claim", async () => {
  const { kit } = setup({}, { appSignIn: true });
  const res = (await kit.handle(req({ url: `${ORIGIN}/session/app?to=${encodeURIComponent("/communities/courses/C1")}`, cookies: { "__Host-zw_session": TOKEN } })))!;
  assert.equal(res.status, 303);
  const location = new URL(res.headers.Location!);
  assert.equal(`${location.origin}${location.pathname}`, `${APP}/session/claim`);
  assert.equal(location.searchParams.get("return_origin"), ORIGIN);
  assert.equal(location.searchParams.get("to"), "/communities/courses/C1");
});

test("/session/app refuses an open redirect: to=//evil is /", async () => {
  const { kit } = setup({}, { appSignIn: true });
  for (const to of ["//evil.example", "https://evil.example", "/\\evil.example", "/\t/evil.example"]) {
    const res = (await kit.handle(req({ url: `${ORIGIN}/session/app?to=${encodeURIComponent(to)}`, cookies: { "__Host-zw_session": TOKEN } })))!;
    assert.equal(new URL(res.headers.Location!).searchParams.get("to"), "/", to);
  }
  const off = setup({});
  const plain = (await off.kit.handle(req({ url: `${ORIGIN}/session/app?to=${encodeURIComponent("//evil.example")}` })))!;
  assert.equal(plain.headers.Location, `${APP}/`);
});

test("/session/app with appSignIn off (default) or signed out opens the plain app address", async () => {
  const { kit } = setup({});
  const off = (await kit.handle(req({ url: `${ORIGIN}/session/app?to=%2Fonboarding%2Fprofile`, cookies: { "__Host-zw_session": TOKEN } })))!;
  assert.equal(off.headers.Location, `${APP}/onboarding/profile`);
  const on = setup({}, { appSignIn: true });
  const out = (await on.kit.handle(req({ url: `${ORIGIN}/session/app?to=%2Fonboarding%2Fprofile` })))!;
  assert.equal(out.headers.Location, `${APP}/onboarding/profile`);
});

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "s".repeat(43);
const APP_CODE = "a1".repeat(32);

test("/session/app-code: a code for the app's callback, no-referrer and no-store", async () => {
  const { kit, calls } = setup({ "app-code": { status: 200, body: { code: APP_CODE } } }, { appSignIn: true });
  const res = (await kit.handle(req({ url: `${ORIGIN}/session/app-code?state=${STATE}&code_challenge=${CHALLENGE}`, cookies: { "__Host-zw_session": TOKEN } })))!;
  assert.equal(res.status, 302);
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers.Location, `${APP}/session/claim/callback?code=${APP_CODE}&state=${STATE}`);
  assert.deepEqual(calls[0]!.body, { realm: "acme", origin: ORIGIN, sessionToken: TOKEN, codeChallenge: CHALLENGE });
});

test("/session/app-code without a session (or refused, or off) is error=login_required", async () => {
  const { kit, calls } = setup({ "app-code": { status: 400, body: { error: "login_required" } } }, { appSignIn: true });
  const none = (await kit.handle(req({ url: `${ORIGIN}/session/app-code?state=${STATE}&code_challenge=${CHALLENGE}` })))!;
  assert.equal(none.headers.Location, `${APP}/session/claim/callback?error=login_required&state=${STATE}`);
  assert.equal(calls.length, 0);
  const refused = (await kit.handle(req({ url: `${ORIGIN}/session/app-code?state=${STATE}&code_challenge=${CHALLENGE}`, cookies: { "__Host-zw_session": TOKEN } })))!;
  assert.equal(refused.headers.Location, `${APP}/session/claim/callback?error=login_required&state=${STATE}`);
  const off = setup({});
  const offRes = (await off.kit.handle(req({ url: `${ORIGIN}/session/app-code?state=${STATE}&code_challenge=${CHALLENGE}`, cookies: { "__Host-zw_session": TOKEN } })))!;
  assert.equal(offRes.headers.Location, `${APP}/session/claim/callback?error=login_required&state=${STATE}`);
  assert.equal(off.calls.length, 0);
  const badState = (await kit.handle(req({ url: `${ORIGIN}/session/app-code?state=bad&code_challenge=${CHALLENGE}`, cookies: { "__Host-zw_session": TOKEN } })))!;
  assert.equal(badState.status, 400);
});
