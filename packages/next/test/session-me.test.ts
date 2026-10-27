/** How the browser reads GET /session/me: anything unexpected is signed out. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readSessionMe } from "../src/session-me.ts";

test("a member answer keeps the name strings and the sign-out value only", () => {
  assert.deepEqual(readSessionMe({ member: { firstName: "Asha", lastName: "Rao", email: "x@y.z" }, signOutToken: "t" }), {
    member: { firstName: "Asha", lastName: "Rao" },
    signOutToken: "t",
    accountUrl: null,
  });
  assert.deepEqual(readSessionMe({ member: {}, signOutToken: null }), { member: {}, signOutToken: null, accountUrl: null });
});

for (const data of [null, undefined, "x", 1, {}, { member: null }, { member: "Asha" }]) {
  test(`${JSON.stringify(data) ?? "undefined"} reads as signed out`, () => {
    assert.deepEqual(readSessionMe(data), { member: null, signOutToken: null, accountUrl: null });
  });
}
