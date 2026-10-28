/**
 * createSessionRoutes serves the v0.2.0 code step and app link through the
 * same [action] route (Web Request / Response).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createWebsiteKit } from "@zwingd-ce/website-kit";

import { createSessionRoutes } from "../src/routes.ts";

const ORIGIN = "https://www.example.org";
const APP = "https://app.example.org";
const TOKEN = "e".repeat(64);
const CSRF = "c".repeat(43);
const TICKET = { ticketId: "tk_1", codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: "2026-10-28T10:01:00.000Z" };

function setup(appSignIn = false) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const call = String(input).split("/session-handover/")[1]!;
    calls.push(call);
    const body =
      call === "code/start"
        ? TICKET
        : call === "code/verify"
          ? { sessionToken: TOKEN, expiresAt: "2099-01-01T00:00:00.000Z", member: { firstName: "Asha", lastName: "Rao" }, isNewAccount: true }
          : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const kit = createWebsiteKit({ apiUrl: "https://api.example.com", appUrl: APP, realm: "acme", clientSecret: "zsh_" + "c".repeat(64), origin: ORIGIN, fetch: fetchImpl, appSignIn });
  return { calls, routes: createSessionRoutes(kit) };
}

const form = (path: string, body: string, cookie: string, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7", ...headers },
    body,
  });

test("POST /session/code-start then /session/code-verify: cookies set, the body never has isNewAccount", async () => {
  const { routes, calls } = setup();
  const started = await routes.POST(form("/session/code-start", `csrf=${CSRF}&email=buyer%40example.org`, `__Host-zw_csrf=${CSRF}`));
  assert.equal(started.status, 200);
  const ticket = started.headers.getSetCookie().find((c) => c.startsWith("__Host-zw_ticket="))!.split(";")[0]!;

  const verified = await routes.POST(form("/session/code-verify", `csrf=${CSRF}&code=123456`, `__Host-zw_csrf=${CSRF}; ${ticket}`));
  assert.equal(verified.status, 200);
  const text = await verified.text();
  assert.ok(!text.includes("isNewAccount"));
  assert.deepEqual(JSON.parse(text).notice, "account-ready");
  const names = verified.headers.getSetCookie().map((c) => c.split("=")[0]);
  for (const name of ["__Host-zw_session", "__Host-zw_csrf", "__Host-zw_new"]) assert.ok(names.includes(name), name);
  assert.deepEqual(calls, ["code/start", "code/verify"]);
});

test("a cross-site code POST is 403 and never reaches the API", async () => {
  const { routes, calls } = setup();
  const res = await routes.POST(form("/session/code-start", `csrf=${CSRF}&email=a%40b.co`, `__Host-zw_csrf=${CSRF}`, { origin: "https://evil.example" }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("GET /session/app refuses to=//evil", async () => {
  const { routes } = setup(true);
  const res = await routes.GET(new Request(`${ORIGIN}/session/app?to=%2F%2Fevil.example`, { headers: { cookie: `__Host-zw_session=${TOKEN}` } }));
  assert.equal(res.status, 303);
  assert.equal(new URL(res.headers.get("location")!).searchParams.get("to"), "/");
});

test("GET /session/app-code without a session is error=login_required", async () => {
  const { routes, calls } = setup(true);
  const state = "s".repeat(43);
  const res = await routes.GET(new Request(`${ORIGIN}/session/app-code?state=${state}&code_challenge=${"x".repeat(43)}`));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `${APP}/session/claim/callback?error=login_required&state=${state}`);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(calls.length, 0);
});
