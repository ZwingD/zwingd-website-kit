/**
 * The Node adapter serves the three routes from a real Express app over HTTP:
 * start, a callback with a good code, getMember on a page, and a same-site
 * sign-out. The API is a fake `fetch`; nothing leaves the machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import express from "express";

import { createSessionHandler, createWebsiteKit, getMember, signOutFormToken } from "../src/index.ts";

const ORIGIN = "http://localhost:3100";
const APP = "http://localhost:4200";
const SECRET = "zsh_" + "b".repeat(64);
const TOKEN = "e".repeat(64);
const CODE = "d".repeat(64);
const EXPIRES = new Date(Date.now() + 3600_000).toISOString();
const MEMBER = { id: "6520f1c2a3b4c5d6e7f80912", firstName: "Asha", lastName: "Rao" };

function fakeApi() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const call = String(input).slice(String(input).lastIndexOf("/") + 1);
    calls.push(call);
    const body =
      call === "exchange"
        ? { sessionToken: TOKEN, expiresAt: EXPIRES, member: MEMBER }
        : call === "session"
          ? { active: true, expiresAt: EXPIRES, member: MEMBER }
          : { ended: true, appSignOutUrl: `${APP}/session/sign-out?return_origin=${encodeURIComponent(ORIGIN)}` };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

async function serve() {
  const api = fakeApi();
  const kit = createWebsiteKit({ apiUrl: "http://localhost:3000", appUrl: APP, realm: "acme", clientSecret: SECRET, origin: ORIGIN, insecureLocalCookies: true, fetch: api.fetch });
  const app = express();
  app.use(createSessionHandler(kit));
  app.get("/", async (req, res) => {
    const member = await getMember(kit, req, res);
    const csrf = member.status === "signed-in" ? signOutFormToken(kit, req, res) : "";
    res.json({ status: member.status, name: member.status === "signed-in" ? member.member?.firstName ?? null : null, csrf });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { api, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** name=value pairs from a response's Set-Cookie headers; removals delete. */
function absorb(res: Response, jar: Map<string, string>) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    if (/Max-Age=0/.test(line)) jar.delete(pair!.slice(0, eq));
    else jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
}
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

test("Express serves start, callback and end, and the page sees the member", async () => {
  const { api, base, close } = await serve();
  try {
    const jar = new Map<string, string>();

    const start = await fetch(`${base}/session/start?next=/courses/x`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const handover = new URL(start.headers.get("location")!);
    assert.equal(`${handover.origin}${handover.pathname}`, `${APP}/session/handover`);
    assert.equal(start.headers.get("cache-control"), "no-store");
    absorb(start, jar);
    assert.ok(jar.has("zw_start"));

    const state = handover.searchParams.get("state")!;
    const callback = await fetch(`${base}/session/callback?code=${CODE}&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar) },
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/courses/x");
    assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
    absorb(callback, jar);
    assert.equal(jar.get("zw_session"), TOKEN);
    assert.equal(jar.has("zw_start"), false);

    const page = await (await fetch(`${base}/`, { headers: { cookie: cookieHeader(jar) } })).json();
    assert.equal(page.status, "signed-in");
    assert.equal(page.name, "Asha");
    assert.equal(page.csrf, jar.get("zw_csrf"));

    // A GET to /session/end ends nothing.
    assert.equal((await fetch(`${base}/session/end`, { redirect: "manual", headers: { cookie: cookieHeader(jar) } })).status, 405);
    // A cross-site POST is refused.
    const cross = await fetch(`${base}/session/end`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookieHeader(jar), origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: `csrf=${page.csrf}`,
    });
    assert.equal(cross.status, 403);
    assert.equal(api.calls.includes("end"), false);

    const end = await fetch(`${base}/session/end`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookieHeader(jar), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf=${page.csrf}`,
    });
    assert.equal(end.status, 303);
    assert.equal(end.headers.get("location"), `${APP}/session/sign-out?return_origin=${encodeURIComponent(ORIGIN)}`);
    absorb(end, jar);
    assert.equal(jar.has("zw_session"), false);
    assert.deepEqual(api.calls, ["exchange", "end"]);

    const after = await (await fetch(`${base}/`, { headers: { cookie: cookieHeader(jar) } })).json();
    assert.equal(after.status, "signed-out");
  } finally {
    await close();
  }
});

test("a path outside /session/ goes to the site; an unknown /session/ path is the site's too", async () => {
  const { base, close } = await serve();
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/session/other`)).status, 404);
  } finally {
    await close();
  }
});

test("kit #10: Express sends a member back from the app's sign-out (which lands on /) to the page they signed out from", async () => {
  const { base, close } = await serve();
  try {
    const jar = new Map<string, string>();
    const start = await fetch(`${base}/session/start`, { redirect: "manual" });
    absorb(start, jar);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    absorb(await fetch(`${base}/session/callback?code=${CODE}&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: cookieHeader(jar) } }), jar);
    const end = await fetch(`${base}/session/end`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookieHeader(jar), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: jar.get("zw_csrf")!, next: "/courses/x" }).toString(),
    });
    assert.equal(end.status, 303);
    absorb(end, jar);
    const home = await fetch(`${base}/`, { redirect: "manual", headers: { cookie: cookieHeader(jar) } });
    assert.equal(home.status, 303);
    assert.equal(home.headers.get("location"), "/courses/x");
    absorb(home, jar);
    // The next visit to / is the page itself.
    assert.equal((await fetch(`${base}/`, { redirect: "manual", headers: { cookie: cookieHeader(jar) } })).status, 200);
  } finally {
    await close();
  }
});
