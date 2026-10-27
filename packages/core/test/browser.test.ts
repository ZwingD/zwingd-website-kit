/**
 * startMemberCheckout: the browser half of member checkout. It posts to the
 * site's own /session/checkout, keeps the order token in sessionStorage under
 * the site's key in the record #1866's return page reads, and only then sends
 * the browser to payment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { startMemberCheckout } from "../src/browser.ts";

const OFFER = "6520f1c2a3b4c5d6e7f80a01";
const GATEWAY = "6520f1c2a3b4c5d6e7f80c03";
const ORDER = "6520f1c2a3b4c5d6e7f80d04";
const CSRF = "c".repeat(43);
const REDIRECT = {
  kind: "redirect",
  url: "https://pay.example.org/c/pay/cs_test_a1b2c3",
  orderId: ORDER,
  orderToken: "ot_order_read_token",
  orderTokenExpiresAt: "2026-10-29T10:00:00.000Z",
  resumed: false,
};

function memoryStorage(failing = false) {
  const items = new Map<string, string>();
  return {
    items,
    storage: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (failing) throw new DOMException("quota", "QuotaExceededError");
        items.set(k, v);
      },
      removeItem: (k: string) => void items.delete(k),
    },
  };
}

function fakeSite(reply: { status: number; body?: unknown } | "network") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const storageKey = (orderId: string) => `scpmi:checkout:order:${orderId}`;

test("posts a same-origin form to /session/checkout with the CSRF value; no return address is ever sent", async () => {
  const site = fakeSite({ status: 200, body: REDIRECT });
  const { storage } = memoryStorage();
  await startMemberCheckout(OFFER, {
    csrf: CSRF,
    expectedTotalMinor: "227900",
    paymentGateway: GATEWAY,
    couponCode: "SAVE10",
    attribution: { utmSource: "news" },
    storageKey,
    fetch: site.fetch,
    storage,
    navigate: () => undefined,
  });
  assert.equal(site.calls.length, 1);
  const { url, init } = site.calls[0]!;
  assert.equal(url, "/session/checkout");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "same-origin");
  assert.equal(new Headers(init.headers).get("content-type"), "application/x-www-form-urlencoded");
  const body = Object.fromEntries(new URLSearchParams(String(init.body)));
  assert.deepEqual(body, {
    csrf: CSRF,
    offer: OFFER,
    expectedTotalMinor: "227900",
    paymentGateway: GATEWAY,
    couponCode: "SAVE10",
    utmSource: "news",
  });
});

test("redirect: the order token is stored under the site's key, in the record the return page reads, before navigating", async () => {
  const site = fakeSite({ status: 200, body: REDIRECT });
  const { storage, items } = memoryStorage();
  const order: string[] = [];
  const result = await startMemberCheckout(OFFER, {
    csrf: CSRF,
    expectedTotalMinor: "227900",
    storageKey,
    email: "asha@example.org",
    coursePath: "/courses/project-management",
    fetch: site.fetch,
    storage: { ...storage, setItem: (k: string, v: string) => (order.push("store"), storage.setItem(k, v)) },
    navigate: (to) => void order.push(`navigate ${to}`),
  });
  assert.deepEqual(result, REDIRECT);
  assert.deepEqual(order, ["store", `navigate ${REDIRECT.url}`]);
  // The shape scpmi-website's StoredCheckout (logic.ts) parses: orderId, token, email, coursePath, expiresAt.
  assert.deepEqual(JSON.parse(items.get(`scpmi:checkout:order:${ORDER}`)!), {
    orderId: ORDER,
    token: "ot_order_read_token",
    email: "asha@example.org",
    coursePath: "/courses/project-management",
    expiresAt: "2026-10-29T10:00:00.000Z",
  });
});

test("storage that cannot be written: no navigation, fallback storage-unavailable", async () => {
  const site = fakeSite({ status: 200, body: REDIRECT });
  let navigated = false;
  const result = await startMemberCheckout(OFFER, {
    csrf: CSRF,
    expectedTotalMinor: "227900",
    storageKey,
    fetch: site.fetch,
    storage: memoryStorage(true).storage,
    navigate: () => void (navigated = true),
  });
  assert.deepEqual(result, { kind: "fallback", reason: "storage-unavailable" });
  assert.equal(navigated, false);
});

test("a redirect with no order token is not followed (the return page could not read the order)", async () => {
  const site = fakeSite({ status: 200, body: { ...REDIRECT, orderToken: null } });
  let navigated = false;
  const result = await startMemberCheckout(OFFER, {
    csrf: CSRF,
    expectedTotalMinor: "227900",
    storageKey,
    fetch: site.fetch,
    storage: memoryStorage().storage,
    navigate: () => void (navigated = true),
  });
  assert.deepEqual(result, { kind: "fallback", reason: "storage-unavailable" });
  assert.equal(navigated, false);
});

test("fallback and already-owned answers pass through, with no navigation", async () => {
  for (const body of [
    { kind: "fallback", reason: "signed-out" },
    { kind: "fallback", reason: "checkout-disabled" },
    { kind: "already-owned" },
  ]) {
    let navigated = false;
    const result = await startMemberCheckout(OFFER, {
      csrf: CSRF,
      expectedTotalMinor: "227900",
      storageKey,
      fetch: fakeSite({ status: 200, body }).fetch,
      storage: memoryStorage().storage,
      navigate: () => void (navigated = true),
    });
    assert.deepEqual(result, body);
    assert.equal(navigated, false);
  }
});

test("a 403, a 500, a non-JSON answer or a network fault: fallback unavailable", async () => {
  for (const reply of [{ status: 403 }, { status: 500 }, { status: 200, body: "not an answer" }, "network"] as const) {
    const result = await startMemberCheckout(OFFER, {
      csrf: CSRF,
      expectedTotalMinor: "227900",
      storageKey,
      fetch: fakeSite(reply as never).fetch,
      storage: memoryStorage().storage,
      navigate: () => assert.fail("navigated"),
    });
    assert.deepEqual(result, { kind: "fallback", reason: "unavailable" });
  }
});
