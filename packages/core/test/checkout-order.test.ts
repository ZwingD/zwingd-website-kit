/** v0.2.0: the return page's record, written by storeCheckoutOrder and read back by readCheckoutOrder. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readCheckoutOrder, storeCheckoutOrder } from "../src/browser.ts";

const ORDER = "6520f1c2a3b4c5d6e7f80a04";
const key = (id: string) => `site:order:${id}`;

function memory() {
  const map = new Map<string, string>();
  return { map, setItem: (k: string, v: string) => void map.set(k, v), getItem: (k: string) => map.get(k) ?? null };
}

test("readCheckoutOrder reads back what storeCheckoutOrder kept, member or verified buyer", () => {
  for (const member of [true, false]) {
    const storage = memory();
    assert.equal(storeCheckoutOrder({ orderId: ORDER, orderToken: "ot_1", orderTokenExpiresAt: null }, { storageKey: key, storage, member, coursePath: "/c/x" }), true);
    assert.deepEqual(readCheckoutOrder(ORDER, { storageKey: key, storage }), { orderId: ORDER, token: "ot_1", email: "", coursePath: "/c/x", expiresAt: null, member });
  }
});

test("readCheckoutOrder is null with no storage, no record, another order's record, or one not in the kit's shape", () => {
  assert.equal(readCheckoutOrder(ORDER, { storageKey: key, storage: null }), null);
  const storage = memory();
  assert.equal(readCheckoutOrder(ORDER, { storageKey: key, storage }), null);
  for (const raw of ["{", "null", JSON.stringify({ orderId: "other", token: "t", member: false }), JSON.stringify({ orderId: ORDER, token: "", member: false }), JSON.stringify({ orderId: ORDER, token: "t" })]) {
    storage.map.set(key(ORDER), raw);
    assert.equal(readCheckoutOrder(ORDER, { storageKey: key, storage }), null, raw);
  }
  const throwing = { getItem: () => { throw new Error("blocked"); } };
  assert.equal(readCheckoutOrder(ORDER, { storageKey: key, storage: throwing }), null);
});
