/**
 * Re-checking a session (session hand-over v1, "Re-checking a session"): a 60 s
 * cache keyed by the token's hash, the session dropped only on `active: false`,
 * contact details only from a check under 60 s old.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createWebsiteKit } from "../src/flows.ts";
import { API, APP, fakeApi, ORIGIN, SECRET, TOKEN } from "./helpers.ts";

const MEMBER = { id: "6520f1c2a3b4c5d6e7f80912", firstName: "Asha", lastName: "Rao", email: "asha@example.org", mobile: "9876543210" };
const ACTIVE = { status: 200, body: { active: true, expiresAt: "2026-10-27T18:00:00.000Z", member: MEMBER } };
const cookies = { "__Host-zw_session": TOKEN };

function kitWith(session: Parameters<typeof fakeApi>[0]["session"]) {
  let now = Date.parse("2026-10-27T10:00:00.000Z");
  const api = fakeApi({ session });
  const kit = createWebsiteKit({ apiUrl: API, appUrl: APP, realm: "acme", clientSecret: SECRET, origin: ORIGIN, fetch: api.fetch, now: () => now, timeoutMs: 20 });
  return { kit, api, advance: (ms: number) => (now += ms) };
}

test("no session cookie, or a malformed one: signed out, and no call", async () => {
  const { kit, api } = kitWith(ACTIVE);
  assert.deepEqual(await kit.getMember({}), { status: "signed-out" });
  assert.deepEqual(await kit.getMember({ "__Host-zw_session": "not-a-token" }), { status: "signed-out" });
  assert.equal(api.calls.length, 0);
});

test("a good check answers the member and contact; a second read within 60 s uses the cache", async () => {
  const { kit, api, advance } = kitWith([ACTIVE, ACTIVE]);
  const first = await kit.getMember(cookies);
  assert.deepEqual(first, {
    status: "signed-in",
    member: { id: MEMBER.id, firstName: "Asha", lastName: "Rao" },
    contact: { email: MEMBER.email, mobile: MEMBER.mobile },
    fresh: true,
    checkedAt: Date.parse("2026-10-27T10:00:00.000Z"),
  });
  advance(59_000);
  assert.equal((await kit.getMember(cookies)).status, "signed-in");
  assert.equal(api.calls.length, 1);
  advance(2_000);
  await kit.getMember(cookies);
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls[0]!.body, { realm: "acme", origin: ORIGIN, sessionToken: TOKEN });
});

test("active: false drops the session (the site clears its cookie)", async () => {
  const { kit } = kitWith({ status: 200, body: { active: false } });
  assert.deepEqual(await kit.getMember(cookies), { status: "ended" });
  assert.match(kit.clearSessionCookie(), /^__Host-zw_session=;.*Max-Age=0.*Secure/);
});

for (const failure of [{ status: 429, body: { error: "rate_limited" } }, { status: 503, body: { error: "unavailable" } }, { status: 401, body: { error: "invalid_client" } }, "timeout" as const, "network" as const]) {
  const label = typeof failure === "string" ? failure : failure.body.error;
  test(`${label} keeps the session: the name from the last good check, no contact details`, async () => {
    const { kit, advance } = kitWith([ACTIVE, failure]);
    await kit.getMember(cookies);
    advance(61_000);
    assert.deepEqual(await kit.getMember(cookies), {
      status: "signed-in",
      member: { id: MEMBER.id, firstName: "Asha", lastName: "Rao" },
      contact: null,
      fresh: false,
      checkedAt: Date.parse("2026-10-27T10:00:00.000Z"),
    });
  });

  test(`${label} with no earlier check: still signed in, with no name`, async () => {
    const { kit } = kitWith(failure);
    assert.deepEqual(await kit.getMember(cookies), { status: "signed-in", member: null, contact: null, fresh: false, checkedAt: null });
  });
}

test("freshMember always asks the API, even inside the 60 s", async () => {
  const { kit, api } = kitWith([ACTIVE, ACTIVE]);
  await kit.getMember(cookies);
  const fresh = await kit.freshMember(cookies);
  assert.equal(api.calls.length, 2);
  assert.equal(fresh.status === "signed-in" && fresh.fresh, true);
});

test("forget drops the cached check", async () => {
  const { kit, api } = kitWith([ACTIVE, ACTIVE]);
  await kit.getMember(cookies);
  await kit.forget(TOKEN);
  await kit.getMember(cookies);
  assert.equal(api.calls.length, 2);
});
