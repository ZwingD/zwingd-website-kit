/**
 * createSessionRoutes(kit, { checkout }) also serves POST /session/checkout
 * (member checkout); without `checkout` the path is a 404.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemberCheckout, createWebsiteKit } from "@zwingd-ce/website-kit";

import { createSessionRoutes } from "../src/routes.ts";

const ORIGIN = "https://www.example.org";
const TOKEN = "e".repeat(64);
const CSRF = "c".repeat(43);
const OFFER = "6520f1c2a3b4c5d6e7f80a01";
const SESSION = {
  orderId: "6520f1c2a3b4c5d6e7f80d04",
  paymentState: "PENDING",
  redirectUrl: "https://pay.example.org/c/pay/cs_test_1",
  resumed: false,
  orderToken: "ot_order_read_token",
  orderTokenExpiresAt: "2026-10-29T10:00:00.000Z",
};

function setup(withCheckout: boolean) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(input).endsWith("/checkout/start"));
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(SESSION), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const kit = createWebsiteKit({ apiUrl: "https://api.example.com", appUrl: "https://app.example.org", realm: "acme", clientSecret: "zsh_" + "c".repeat(64), origin: ORIGIN, fetch: fetchImpl });
  const routes = withCheckout ? createSessionRoutes(kit, { checkout: createMemberCheckout(kit) }) : createSessionRoutes(kit);
  return { sent, routes };
}

const checkoutRequest = (headers: Record<string, string> = { origin: ORIGIN }, method = "POST") =>
  new Request(`${ORIGIN}/session/checkout`, {
    method,
    headers: { cookie: `__Host-zw_session=${TOKEN}; __Host-zw_csrf=${CSRF}`, "content-type": "application/x-www-form-urlencoded", ...headers },
    ...(method === "POST" ? { body: `csrf=${CSRF}&offer=${OFFER}&expectedTotalMinor=227900&returnUrl=https%3A%2F%2Fevil.example` } : {}),
  });

test("POST /session/checkout answers the JSON redirect, returning to the site's own page", async () => {
  const { sent, routes } = setup(true);
  const res = await routes.POST(checkoutRequest());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).url, SESSION.redirectUrl);
  assert.equal(sent[0]!.returnUrl, `${ORIGIN}/checkout/return`);
});

test("GET is 405 and a cross-site POST is 403; neither reaches the API", async () => {
  const { sent, routes } = setup(true);
  assert.equal((await routes.GET(checkoutRequest({}, "GET"))).status, 405);
  assert.equal((await routes.POST(checkoutRequest({ origin: "https://evil.example" }))).status, 403);
  assert.equal(sent.length, 0);
});

test("without a checkout, /session/checkout is a 404", async () => {
  const { routes } = setup(false);
  assert.equal((await routes.POST(checkoutRequest())).status, 404);
});
