/**
 * The three website routes against a fake API (session hand-over v1, "The
 * three website routes", "Cookies", "Sign-out").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createWebsiteKit } from "../src/flows.ts";
import { API, APP, CODE, cookieNamed, fakeApi, jar, ORIGIN, req, SECRET, TOKEN } from "./helpers.ts";

const NOW = Date.parse("2026-10-27T10:00:00.000Z");
const EXPIRES = "2026-10-27T18:00:00.000Z";
const MEMBER = { id: "6520f1c2a3b4c5d6e7f80912", firstName: "Asha", lastName: "Rao", email: "asha@example.org" };

function kitWith(replies: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi(replies);
  const kit = createWebsiteKit({ apiUrl: API, appUrl: APP, realm: "acme", clientSecret: SECRET, origin: ORIGIN, fetch: api.fetch, now: () => NOW });
  return { kit, api };
}

/** Run /session/start and return its redirect, cookie jar and the values it sent to the app. */
async function started(kit: ReturnType<typeof kitWith>["kit"], next = "/checkout") {
  const res = await kit.start(req({ url: `${ORIGIN}/session/start?next=${encodeURIComponent(next)}&prompt=none` }));
  const location = new URL(res.headers.Location!);
  return { res, location, cookies: jar(res.setCookies), state: location.searchParams.get("state")! };
}

const callbackUrl = (params: Record<string, string>) => `${ORIGIN}/session/callback?${new URLSearchParams(params)}`;

test("start: 302 to the app's hand-over with S256 and prompt=login, whatever the request asked", async () => {
  const { kit } = kitWith({});
  const { res, location, cookies } = await started(kit);
  assert.equal(res.status, 302);
  assert.equal(`${location.origin}${location.pathname}`, `${APP}/session/handover`);
  assert.equal(location.searchParams.get("return_origin"), ORIGIN);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("prompt"), "login");
  assert.match(location.searchParams.get("state")!, /^[A-Za-z0-9\-._~]{16,512}$/);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  // The challenge is base64url(sha256(verifier)) of the verifier kept in the cookie, which never leaves the site.
  const start = JSON.parse(Buffer.from(cookies["__Host-zw_start"]!, "base64url").toString("utf8"));
  assert.match(start.v, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.equal(location.searchParams.get("code_challenge"), createHash("sha256").update(start.v).digest("base64url"));
  assert.equal(location.href.includes(start.v), false);
  assert.equal(start.p, "/checkout");
});

test("start: the start cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes", async () => {
  const { kit } = kitWith({});
  const { res } = await started(kit);
  const line = cookieNamed(res.setCookies, "__Host-zw_start")!;
  for (const part of ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=600", "Secure"]) assert.ok(line.includes(part), part);
});

test("start: a refused saved path is stored as /", async () => {
  const { kit } = kitWith({});
  const { cookies } = await started(kit, "//evil.example");
  assert.equal(JSON.parse(Buffer.from(cookies["__Host-zw_start"]!, "base64url").toString("utf8")).p, "/");
});

test("callback: a state mismatch, or no start cookie, refuses and never calls exchange", async () => {
  const { kit, api } = kitWith({ exchange: { status: 200, body: { sessionToken: TOKEN, expiresAt: EXPIRES, member: MEMBER } } });
  const { cookies } = await started(kit);
  for (const view of [
    req({ url: callbackUrl({ code: CODE, state: "x".repeat(43) }), cookies }),
    req({ url: callbackUrl({ code: CODE, state: "x".repeat(43) }) }),
  ]) {
    const res = await kit.callback(view);
    assert.equal(res.status, 303);
    assert.equal(res.headers.Location, "/");
    assert.equal(cookieNamed(res.setCookies, "__Host-zw_session"), undefined);
    // An honest sign-in still in progress keeps its start cookie.
    assert.equal(cookieNamed(res.setCookies, "__Host-zw_start"), undefined);
  }
  assert.equal(api.calls.length, 0);
});

test("callback: error=login_required clears the start cookie and goes on signed out", async () => {
  const { kit, api } = kitWith({});
  const { cookies, state } = await started(kit);
  const res = await kit.callback(req({ url: callbackUrl({ error: "login_required", state }), cookies }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.Location, "/checkout");
  assert.match(cookieNamed(res.setCookies, "__Host-zw_start")!, /Max-Age=0.*Secure|Secure.*Max-Age=0/);
  assert.ok(cookieNamed(res.setCookies, "__Host-zw_start")!.includes("Path=/"));
  assert.equal(cookieNamed(res.setCookies, "__Host-zw_session"), undefined);
  assert.equal(api.calls.length, 0);
});

test("callback: a good exchange sets the session and CSRF cookies, clears start, 303 to the saved path", async () => {
  const { kit, api } = kitWith({ exchange: { status: 200, body: { sessionToken: TOKEN, expiresAt: EXPIRES, member: MEMBER } } });
  const { cookies, state } = await started(kit);
  const res = await kit.callback(req({ url: callbackUrl({ code: CODE, state }), cookies }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.Location, "/checkout");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  const session = cookieNamed(res.setCookies, "__Host-zw_session")!;
  assert.ok(session.startsWith(`__Host-zw_session=${TOKEN};`));
  for (const part of ["Path=/", "HttpOnly", "SameSite=Lax", "Secure", `Max-Age=${8 * 3600}`]) assert.ok(session.includes(part), part);
  assert.ok(cookieNamed(res.setCookies, "__Host-zw_csrf")!.includes("SameSite=Strict"));
  assert.match(cookieNamed(res.setCookies, "__Host-zw_start")!, /Max-Age=0/);

  assert.equal(api.calls.length, 1);
  const [call] = api.calls;
  assert.equal(call!.url, `${API}/api/external/session-handover/exchange`);
  assert.equal(call!.authorization, `Bearer ${SECRET}`);
  const start = JSON.parse(Buffer.from(cookies["__Host-zw_start"]!, "base64url").toString("utf8"));
  assert.deepEqual(call!.body, { realm: "acme", origin: ORIGIN, code: CODE, codeVerifier: start.v });
  // The secret only ever travels in Authorization.
  assert.equal(JSON.stringify(call!.body).includes(SECRET), false);

  // The first page after sign-in needs no check: the exchange's member is remembered.
  const member = await kit.getMember(jar(res.setCookies));
  assert.equal(member.status, "signed-in");
  assert.equal(api.calls.length, 1);
});

for (const failure of [
  { status: 400, body: { error: "invalid_grant" } },
  { status: 503, body: { error: "unavailable" } },
  { status: 429, body: { error: "rate_limited" } },
  "timeout" as const,
  "network" as const,
]) {
  test(`callback: an exchange failure (${typeof failure === "string" ? failure : failure.body.error}) is called once, never retried, and leaves no session`, async () => {
    const { kit, api } = kitWith({ exchange: failure });
    const fast = createWebsiteKit({ ...kit.config, timeoutMs: 20 });
    const { cookies, state } = await started(fast);
    const res = await fast.callback(req({ url: callbackUrl({ code: CODE, state }), cookies }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.Location, "/checkout");
    assert.equal(cookieNamed(res.setCookies, "__Host-zw_session"), undefined);
    assert.match(cookieNamed(res.setCookies, "__Host-zw_start")!, /Max-Age=0/);
    assert.equal(api.calls.length, 1);
  });
}

test("callback: a code that is not 64 hex is never sent", async () => {
  const { kit, api } = kitWith({});
  const { cookies, state } = await started(kit);
  const res = await kit.callback(req({ url: callbackUrl({ code: "not-a-code", state }), cookies }));
  assert.equal(res.status, 303);
  assert.equal(api.calls.length, 0);
});

/** A signed-in browser: its cookies after a good callback. */
async function signedIn(replies: Parameters<typeof fakeApi>[0]) {
  const { kit, api } = kitWith({ exchange: { status: 200, body: { sessionToken: TOKEN, expiresAt: EXPIRES, member: MEMBER } }, ...replies });
  const { cookies, state } = await started(kit);
  const res = await kit.callback(req({ url: callbackUrl({ code: CODE, state }), cookies }));
  return { kit, api, cookies: jar(res.setCookies) };
}

const endReq = (cookies: Record<string, string>, over: Partial<Parameters<typeof req>[0]> = {}) =>
  req({
    method: "POST",
    url: `${ORIGIN}/session/end`,
    cookies,
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
    form: { csrf: cookies["__Host-zw_csrf"]! },
    ...over,
  });

test("end: a GET never ends anything", async () => {
  const { kit, api, cookies } = await signedIn({ end: { status: 200, body: { ended: true, appSignOutUrl: `${APP}/session/sign-out` } } });
  const res = await kit.end(endReq(cookies, { method: "GET" }));
  assert.equal(res.status, 405);
  assert.deepEqual(res.setCookies, []);
  assert.equal(api.calls.filter((c) => c.url.endsWith("/end")).length, 0);
});

for (const [label, over] of [
  // Origin alone (a browser that sends no Sec-Fetch-Site), with the right CSRF value.
  ["a cross-site Origin", { headers: { origin: "https://evil.example" } }],
  ["an Origin of another port", { headers: { origin: "https://www.example.org:8443" } }],
  ["Sec-Fetch-Site cross-site", { headers: { "sec-fetch-site": "cross-site" } }],
  ["Sec-Fetch-Site same-site (a sibling subdomain)", { headers: { "sec-fetch-site": "same-site" } }],
  ["no CSRF value in the form", { form: {} }],
  ["a wrong CSRF value", { form: { csrf: "x".repeat(43) } }],
] as const) {
  test(`end: refuses ${label}, and ends nothing`, async () => {
    const { kit, api, cookies } = await signedIn({ end: { status: 200, body: { ended: true, appSignOutUrl: `${APP}/session/sign-out` } } });
    const res = await kit.end(endReq(cookies, over as never));
    assert.equal(res.status, 403);
    assert.deepEqual(res.setCookies, []);
    assert.equal(api.calls.filter((c) => c.url.endsWith("/end")).length, 0);
  });
}

test("end: a same-site POST ends the session, clears the cookies and goes to appSignOutUrl", async () => {
  const signOut = `${APP}/session/sign-out?return_origin=${encodeURIComponent(ORIGIN)}#ticket=${"c".repeat(64)}`;
  const { kit, api, cookies } = await signedIn({ end: { status: 200, body: { ended: true, appSignOutUrl: signOut, signOutTicket: "c".repeat(64) } } });
  const res = await kit.end(endReq(cookies));
  assert.equal(res.status, 303);
  assert.equal(res.headers.Location, signOut);
  for (const name of ["__Host-zw_session", "__Host-zw_csrf"]) {
    const line = cookieNamed(res.setCookies, name)!;
    for (const part of ["Max-Age=0", "Path=/", "Secure"]) assert.ok(line.includes(part), `${name} ${part}`);
  }
  const call = api.calls.find((c) => c.url.endsWith("/end"))!;
  assert.deepEqual(call.body, { realm: "acme", origin: ORIGIN, sessionToken: TOKEN });
});

for (const failure of [{ status: 401, body: { error: "invalid_client" } }, { status: 503, body: { error: "unavailable" } }, "network" as const]) {
  test(`end: a failed end (${typeof failure === "string" ? failure : failure.body.error}) still clears the cookies and goes to the app's sign-out`, async () => {
    const { kit, cookies } = await signedIn({ end: failure });
    const res = await kit.end(endReq(cookies));
    assert.equal(res.status, 303);
    assert.equal(res.headers.Location, `${APP}/session/sign-out?return_origin=${encodeURIComponent(ORIGIN)}`);
    assert.match(cookieNamed(res.setCookies, "__Host-zw_session")!, /Max-Age=0/);
  });
}

test("end: appSignOutUrl null falls back to the app's sign-out", async () => {
  const { kit, cookies } = await signedIn({ end: { status: 200, body: { ended: true, appSignOutUrl: null } } });
  const res = await kit.end(endReq(cookies));
  assert.equal(res.headers.Location, `${APP}/session/sign-out?return_origin=${encodeURIComponent(ORIGIN)}`);
});

test("handle: routes the four paths and leaves every other path alone", async () => {
  const { kit } = kitWith({});
  assert.equal((await kit.handle(req({ url: `${ORIGIN}/session/start` })))?.status, 302);
  assert.equal((await kit.handle(req({ url: `${ORIGIN}/session/end` })))?.status, 405);
  assert.equal((await kit.handle(req({ url: `${ORIGIN}/session/me` })))?.status, 200);
  assert.equal(await kit.handle(req({ url: `${ORIGIN}/courses/x` })), null);
});

test("insecureLocalCookies: unprefixed names and no Secure, for http://localhost only", async () => {
  const api = fakeApi({});
  const kit = createWebsiteKit({ apiUrl: "http://localhost:3000", appUrl: "http://localhost:4200", realm: "acme", clientSecret: SECRET, origin: "http://localhost:3100", insecureLocalCookies: true, fetch: api.fetch });
  const res = await kit.start(req({ url: "http://localhost:3100/session/start" }));
  const line = cookieNamed(res.setCookies, "zw_start")!;
  assert.ok(line);
  assert.equal(line.includes("Secure"), false);
});

const ACTIVE = { status: 200, body: { active: true, expiresAt: EXPIRES, member: MEMBER } };
const signedInCookies = (csrf?: string) => ({ "__Host-zw_session": TOKEN, ...(csrf ? { "__Host-zw_csrf": csrf } : {}) });

test("me: signed in answers the name only and the sign-out value, no-store, Vary: Cookie", async () => {
  const { kit } = kitWith({ session: ACTIVE });
  const csrf = "c".repeat(43);
  const res = await kit.handle(req({ url: `${ORIGIN}/session/me`, cookies: signedInCookies(csrf), headers: { "sec-fetch-site": "same-origin" } }));
  assert.equal(res?.status, 200);
  assert.equal(res?.headers["Cache-Control"], "no-store");
  assert.equal(res?.headers.Vary, "Cookie");
  assert.match(res!.headers["Content-Type"]!, /^application\/json/);
  assert.deepEqual(JSON.parse(res!.body!), { member: { firstName: "Asha", lastName: "Rao" }, signOutToken: csrf });
  assert.equal(res!.body!.includes("asha@example.org"), false);
  assert.deepEqual(res?.setCookies, []);
});

test("me: a signed-in browser with no CSRF cookie gets one minted and set", async () => {
  const { kit } = kitWith({ session: ACTIVE });
  const res = await kit.me(req({ url: `${ORIGIN}/session/me`, cookies: signedInCookies() }));
  const body = JSON.parse(res.body!);
  const line = cookieNamed(res.setCookies, "__Host-zw_csrf")!;
  assert.ok(line.includes("SameSite=Strict"));
  assert.equal(jar(res.setCookies)["__Host-zw_csrf"], body.signOutToken);
});

test("me: signed out answers null and never calls the API", async () => {
  const { kit, api } = kitWith({});
  const res = await kit.me(req({ url: `${ORIGIN}/session/me` }));
  assert.deepEqual(JSON.parse(res.body!), { member: null, signOutToken: null });
  assert.equal(api.calls.length, 0);
});

test("me: active false answers null and clears the session cookie", async () => {
  const { kit } = kitWith({ session: { status: 200, body: { active: false } } });
  const res = await kit.me(req({ url: `${ORIGIN}/session/me`, cookies: signedInCookies("c".repeat(43)) }));
  assert.deepEqual(JSON.parse(res.body!), { member: null, signOutToken: null });
  assert.match(cookieNamed(res.setCookies, "__Host-zw_session")!, /Max-Age=0/);
});

test("me: a 503 keeps the member signed in, with no name yet", async () => {
  const { kit } = kitWith({ session: { status: 503 } });
  const res = await kit.me(req({ url: `${ORIGIN}/session/me`, cookies: signedInCookies("c".repeat(43)) }));
  assert.deepEqual(JSON.parse(res.body!).member, {});
  assert.deepEqual(res.setCookies, []);
});

test("me: the check is cached, so a second read within 60 s calls the API once", async () => {
  const { kit, api } = kitWith({ session: ACTIVE });
  for (let i = 0; i < 2; i += 1) await kit.me(req({ url: `${ORIGIN}/session/me`, cookies: signedInCookies("c".repeat(43)) }));
  assert.equal(api.calls.length, 1);
});

for (const [label, headers] of [
  ["a cross-site Sec-Fetch-Site", { "sec-fetch-site": "cross-site" }],
  ["a same-site (not same-origin) Sec-Fetch-Site", { "sec-fetch-site": "same-site" }],
  ["a foreign Origin", { origin: "https://evil.example" }],
] as const) {
  test(`me: refuses ${label} with 403 before any check`, async () => {
    const { kit, api } = kitWith({ session: ACTIVE });
    const res = await kit.me(req({ url: `${ORIGIN}/session/me`, cookies: signedInCookies("c".repeat(43)), headers }));
    assert.equal(res.status, 403);
    assert.equal(res.body, undefined);
    assert.equal(api.calls.length, 0);
  });
}

test("me: POST is 405, HEAD has no body", async () => {
  const { kit } = kitWith({});
  assert.equal((await kit.me(req({ method: "POST", url: `${ORIGIN}/session/me` }))).status, 405);
  const head = await kit.me(req({ method: "HEAD", url: `${ORIGIN}/session/me` }));
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
});
