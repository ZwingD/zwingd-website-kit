/**
 * The App Router handlers on Web Requests: start, callback with a good code,
 * and a same-site sign-out, against a fake API. No Next runtime is needed:
 * the handlers use only Request and Response.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createWebsiteKit } from "@zwingd-ce/website-kit";

import { createSessionRoutes, signOutReturn } from "../src/routes.ts";

const ORIGIN = "https://www.example.org";
const APP = "https://app.example.org";
const TOKEN = "e".repeat(64);
const CODE = "d".repeat(64);
const EXPIRES = new Date(Date.now() + 3600_000).toISOString();

function setup() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const call = String(input).slice(String(input).lastIndexOf("/") + 1);
    calls.push(call);
    const body =
      call === "exchange"
        ? { sessionToken: TOKEN, expiresAt: EXPIRES, member: { id: "m1", firstName: "Asha" } }
        : { ended: true, appSignOutUrl: `${APP}/session/sign-out?return_origin=${encodeURIComponent(ORIGIN)}` };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const kit = createWebsiteKit({ apiUrl: "https://api.example.com", appUrl: APP, realm: "acme", clientSecret: "zsh_" + "c".repeat(64), origin: ORIGIN, fetch: fetchImpl });
  return { calls, kit, routes: createSessionRoutes(kit) };
}

const jarFrom = (res: Response, jar: Map<string, string>) => {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    if (/Max-Age=0/.test(line)) jar.delete(pair!.slice(0, eq));
    else jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
};
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

test("start, callback and a same-site sign-out through GET and POST", async () => {
  const { calls, routes } = setup();
  const jar = new Map<string, string>();

  const start = await routes.GET(new Request(`${ORIGIN}/session/start?next=/programmes`));
  assert.equal(start.status, 302);
  assert.equal(start.headers.get("cache-control"), "no-store");
  jarFrom(start, jar);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;

  const callback = await routes.GET(
    new Request(`${ORIGIN}/session/callback?code=${CODE}&state=${encodeURIComponent(state)}`, { headers: { cookie: cookieHeader(jar) } }),
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/programmes");
  assert.equal(callback.headers.getSetCookie().length, 3);
  jarFrom(callback, jar);
  assert.equal(jar.get("__Host-zw_session"), TOKEN);
  const csrf = jar.get("__Host-zw_csrf")!;

  // A GET never ends the session; a cross-site POST is refused.
  assert.equal((await routes.GET(new Request(`${ORIGIN}/session/end`, { headers: { cookie: cookieHeader(jar) } }))).status, 405);
  const cross = await routes.POST(
    new Request(`${ORIGIN}/session/end`, {
      method: "POST",
      headers: { cookie: cookieHeader(jar), origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: `csrf=${csrf}`,
    }),
  );
  assert.equal(cross.status, 403);

  const end = await routes.POST(
    new Request(`${ORIGIN}/session/end`, {
      method: "POST",
      headers: { cookie: cookieHeader(jar), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: `csrf=${csrf}`,
    }),
  );
  assert.equal(end.status, 303);
  assert.match(end.headers.get("location")!, /^https:\/\/app\.example\.org\/session\/sign-out/);
  jarFrom(end, jar);
  assert.equal(jar.has("__Host-zw_session"), false);
  assert.deepEqual(calls, ["exchange", "end"]);
});

test("any other /session/ path answers 404", async () => {
  const { routes } = setup();
  assert.equal((await routes.GET(new Request(`${ORIGIN}/session/other`))).status, 404);
});

test("GET /session/me answers JSON with no-store, and refuses a cross-site read", async () => {
  const { routes } = setup();
  const res = await routes.GET(new Request(`${ORIGIN}/session/me`, { headers: { "sec-fetch-site": "same-origin" } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-type")!, /^application\/json/);
  assert.deepEqual(await res.json(), { member: null, signOutToken: null, accountUrl: null });

  const cross = await routes.GET(new Request(`${ORIGIN}/session/me`, { headers: { "sec-fetch-site": "cross-site" } }));
  assert.equal(cross.status, 403);
  assert.equal(await cross.text(), "");
});

test("kit #10: sign-out from a course page; the app returns to /, and middleware sends the member back to the course", async () => {
  const { kit, routes } = setup();
  const jar = new Map<string, string>();
  const start = await routes.GET(new Request(`${ORIGIN}/session/start`));
  jarFrom(start, jar);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  jarFrom(await routes.GET(new Request(`${ORIGIN}/session/callback?code=${CODE}&state=${encodeURIComponent(state)}`, { headers: { cookie: cookieHeader(jar) } })), jar);
  const csrf = jar.get("__Host-zw_csrf")!;
  const end = await routes.POST(
    new Request(`${ORIGIN}/session/end`, {
      method: "POST",
      headers: { cookie: cookieHeader(jar), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, next: "/courses/afscm?x=1" }).toString(),
    }),
  );
  assert.match(end.headers.get("location")!, /^https:\/\/app\.example\.org\/session\/sign-out/);
  jarFrom(end, jar);

  // Any page but / is left alone.
  assert.equal(signOutReturn(kit, new Request(`${ORIGIN}/about`, { headers: { cookie: cookieHeader(jar) } })), undefined);
  const back = signOutReturn(kit, new Request(`${ORIGIN}/`, { headers: { cookie: cookieHeader(jar) } }))!;
  assert.equal(back.status, 303);
  assert.equal(back.headers.get("location"), "/courses/afscm?x=1");
  jarFrom(back, jar);
  // Once only.
  assert.equal(signOutReturn(kit, new Request(`${ORIGIN}/`, { headers: { cookie: cookieHeader(jar) } })), undefined);
});

for (const unsafe of ["//evil.example", "https://x", "/\\evil", "/%0a/evil"]) {
  test(`kit #10: an unsafe next ${JSON.stringify(unsafe)} leaves the member on /`, async () => {
    const { kit, routes } = setup();
    const jar = new Map<string, string>();
    const start = await routes.GET(new Request(`${ORIGIN}/session/start`));
    jarFrom(start, jar);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    jarFrom(await routes.GET(new Request(`${ORIGIN}/session/callback?code=${CODE}&state=${encodeURIComponent(state)}`, { headers: { cookie: cookieHeader(jar) } })), jar);
    const end = await routes.POST(
      new Request(`${ORIGIN}/session/end`, {
        method: "POST",
        headers: { cookie: cookieHeader(jar), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: `csrf=${jar.get("__Host-zw_csrf")}&next=${unsafe}`,
      }),
    );
    jarFrom(end, jar);
    assert.equal(signOutReturn(kit, new Request(`${ORIGIN}/`, { headers: { cookie: cookieHeader(jar) } })), undefined);
  });
}
