/**
 * POST /session/checkout through a real Express app: the Node adapter reads the
 * form, runs the core's member checkout and writes its JSON answer. The API is
 * a fake `fetch`; nothing leaves the machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import express from "express";

import { createMemberCheckout, createSessionHandler, createWebsiteKit } from "../src/index.ts";

const ORIGIN = "http://localhost:3100";
const SECRET = "zsh_" + "b".repeat(64);
const TOKEN = "e".repeat(64);
const CSRF = "c".repeat(43);
const OFFER = "6520f1c2a3b4c5d6e7f80a01";
const ORDER = "6520f1c2a3b4c5d6e7f80d04";
const SESSION = {
  orderId: ORDER,
  paymentState: "PENDING",
  redirectUrl: "https://pay.example.org/c/pay/cs_test_1",
  resumed: false,
  orderToken: "ot_order_read_token",
  orderTokenExpiresAt: "2026-10-29T10:00:00.000Z",
};

async function serve(withCheckout = true) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(input).endsWith("/checkout/start"));
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(SESSION), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const kit = createWebsiteKit({ apiUrl: "http://localhost:3000", appUrl: "http://localhost:4200", realm: "acme", clientSecret: SECRET, origin: ORIGIN, insecureLocalCookies: true, fetch: fetchImpl });
  const app = express();
  app.use(createSessionHandler(kit, withCheckout ? { checkout: createMemberCheckout(kit, { visitorCountry: () => null }) } : {}));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { sent, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

const cookies = `zw_session=${TOKEN}; zw_csrf=${CSRF}`;
const formBody = (extra = "") => `csrf=${CSRF}&offer=${OFFER}&expectedTotalMinor=227900${extra}`;

test("POST /session/checkout answers the redirect as JSON, with the site's own return address", async () => {
  const { sent, base, close } = await serve();
  try {
    const res = await fetch(`${base}/session/checkout`, {
      method: "POST",
      headers: { cookie: cookies, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: formBody(`&returnUrl=${encodeURIComponent("https://evil.example/x")}`),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal((await res.json()).url, SESSION.redirectUrl);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.returnUrl, `${ORIGIN}/checkout/return`);
  } finally {
    await close();
  }
});

test("GET is 405, a cross-site POST is 403, and neither reaches the API", async () => {
  const { sent, base, close } = await serve();
  try {
    assert.equal((await fetch(`${base}/session/checkout`, { headers: { cookie: cookies } })).status, 405);
    const cross = await fetch(`${base}/session/checkout`, {
      method: "POST",
      headers: { cookie: cookies, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: formBody(),
    });
    assert.equal(cross.status, 403);
    assert.equal(sent.length, 0);
  } finally {
    await close();
  }
});

test("without a checkout passed to the handler, /session/checkout is not served (404)", async () => {
  const { base, close } = await serve(false);
  try {
    assert.equal((await fetch(`${base}/session/checkout`, { method: "POST" })).status, 404);
  } finally {
    await close();
  }
});
