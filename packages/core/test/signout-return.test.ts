/**
 * kit #10: sign-out comes back to the page the member was on. POST /session/end
 * keeps the form's `next` (saved-path rule) in a 10-minute cookie; the app's
 * sign-out returns the browser to `<origin>/`, where `signOutReturn` sends it on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWebsiteKit } from "../src/flows.ts";
import { API, APP, CODE, cookieNamed, fakeApi, jar, ORIGIN, req, SECRET, TOKEN } from "./helpers.ts";

const NOW = Date.parse("2026-10-27T10:00:00.000Z");
const EXPIRES = "2026-10-27T18:00:00.000Z";
const RETURN = "__Host-zw_return";

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/saved-path.json", import.meta.url), "utf8")) as {
  accepted: string[];
  refused: string[];
};

async function signedIn() {
  const api = fakeApi({
    exchange: { status: 200, body: { sessionToken: TOKEN, expiresAt: EXPIRES, member: { id: "6520f1c2a3b4c5d6e7f80912", firstName: "Asha" } } },
    end: { status: 200, body: { ended: true, appSignOutUrl: `${APP}/session/sign-out?return_origin=${encodeURIComponent(ORIGIN)}` } },
  });
  const kit = createWebsiteKit({ apiUrl: API, appUrl: APP, realm: "acme", clientSecret: SECRET, origin: ORIGIN, fetch: api.fetch, now: () => NOW });
  const start = await kit.start(req({ url: `${ORIGIN}/session/start?next=/` }));
  const state = new URL(start.headers.Location!).searchParams.get("state")!;
  const cb = await kit.callback(req({ url: `${ORIGIN}/session/callback?code=${CODE}&state=${state}`, cookies: jar(start.setCookies) }));
  return { kit, cookies: jar(cb.setCookies) };
}

/** Sign out from a page whose path the form carries as `next`, then land on `<origin>/` as the app sends the browser. */
async function signOutFrom(next: string | undefined) {
  const { kit, cookies } = await signedIn();
  const form: Record<string, string> = { csrf: cookies["__Host-zw_csrf"]! };
  if (next !== undefined) form.next = next;
  const end = await kit.end(
    req({ method: "POST", url: `${ORIGIN}/session/end`, cookies, headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" }, form }),
  );
  assert.equal(end.status, 303);
  // The app's sign-out page is unchanged: the browser goes there first.
  assert.ok(end.headers.Location!.startsWith(`${APP}/session/sign-out`));
  const back = kit.signOutReturn(req({ url: `${ORIGIN}/`, cookies: jar(end.setCookies) }));
  return { kit, end, back };
}

test("sign-out from a course page comes back to that course page", async () => {
  const { end, back } = await signOutFrom("/courses/afscm-complete?tab=outline");
  const line = cookieNamed(end.setCookies, RETURN)!;
  for (const part of ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=600", "Secure"]) assert.ok(line.includes(part), part);
  assert.equal(back?.status, 303);
  assert.equal(back?.headers.Location, "/courses/afscm-complete?tab=outline");
  assert.match(cookieNamed(back!.setCookies, RETURN)!, /Max-Age=0/);
});

for (const unsafe of ["//evil.example", "https://x", "/\\", "/\\evil.example", "/\tevil", "%2F%2Fevil", "javascript:alert(1)", ...fixtures.refused]) {
  test(`an unsafe next ${JSON.stringify(unsafe)} keeps nothing: the member stays on /`, async () => {
    const { end, back } = await signOutFrom(unsafe);
    assert.match(cookieNamed(end.setCookies, RETURN)!, /Max-Age=0/);
    assert.equal(back, null);
  });
}

for (const safe of fixtures.accepted.filter((p) => p !== "/")) {
  test(`an accepted next ${JSON.stringify(safe)} comes back unchanged`, async () => {
    const { back } = await signOutFrom(safe);
    assert.equal(back?.headers.Location, safe);
  });
}

test("no next (an older form) keeps the old behaviour: /", async () => {
  const { back } = await signOutFrom(undefined);
  assert.equal(back, null);
});

test("signOutReturn: only a GET of / with the cookie; a forged cookie value goes to / without it", async () => {
  const { kit } = await signedIn();
  const good = Buffer.from("/courses/x").toString("base64url");
  assert.equal(kit.signOutReturn(req({ url: `${ORIGIN}/about`, cookies: { [RETURN]: good } })), null);
  assert.equal(kit.signOutReturn(req({ method: "POST", url: `${ORIGIN}/`, cookies: { [RETURN]: good } })), null);
  assert.equal(kit.signOutReturn(req({ url: `${ORIGIN}/` })), null);
  for (const forged of [Buffer.from("//evil.example").toString("base64url"), Buffer.from("https://x").toString("base64url"), "not base64!"]) {
    const res = kit.signOutReturn(req({ url: `${ORIGIN}/`, cookies: { [RETURN]: forged } }));
    assert.equal(res?.headers.Location, "/");
    assert.match(cookieNamed(res!.setCookies, RETURN)!, /Max-Age=0/);
  }
});
