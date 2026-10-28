/**
 * createSessionRoutes serves the v0.2.0 code step and the thank-you continue
 * through the same [action] route (Web Request / Response), and
 * CheckoutContinueButton draws the press as a same-site form POST.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { Window } from "happy-dom";

import { createWebsiteKit } from "@zwingd-ce/website-kit";

import { createSessionRoutes } from "../src/routes.ts";

const ORIGIN = "https://www.example.org";
const APP = "https://app.example.org";
const CSRF = "c".repeat(43);
const PROOF = "p".repeat(43);
const NONCE = "n".repeat(43);
const OFFER = "6520f1c2a3b4c5d6e7f80a01";
const TICKET = { ticketId: "tk_1", codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: "2026-10-28T10:01:00.000Z" };
const QUOTE = { offer: OFFER, currencyCode: "USD", minorUnitExponent: 2, totalMinor: "9900", subTotalMinor: "9900", discountTotalMinor: "0", taxTotalMinor: "0", pricesIncludeTax: false, alreadyEnrolled: false, gateways: [] };
const STARTED = { orderId: "6520f1c2a3b4c5d6e7f80a04", paymentState: "PENDING", redirectUrl: "https://checkout.stripe.com/x", resumed: false, orderToken: "ot", orderTokenExpiresAt: null };

function setup() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const call = String(input).split("/session-handover/")[1]!;
    calls.push(call);
    const body: Record<string, unknown> =
      {
        "code/start": TICKET,
        "code/verify": { proof: PROOF, proofExpiresInSeconds: 7200 },
        "checkout/quote": QUOTE,
        "checkout/start": STARTED,
        "checkout-proof/context": { continueAs: "member", proofExpiresInSeconds: 1500 },
        "checkout-proof/continue": { nonce: NONCE, nonceExpiresInSeconds: 60, continueUrl: `${APP}/session/checkout-continue` },
      }[call] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const kit = createWebsiteKit({ apiUrl: "https://api.example.com", appUrl: APP, realm: "acme", clientSecret: "zsh_" + "c".repeat(64), origin: ORIGIN, fetch: fetchImpl });
  return { calls, kit, routes: createSessionRoutes(kit) };
}

const form = (path: string, body: string, cookie: string, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7", ...headers },
    body,
  });

test("POST /session/code-start then /session/code-verify: proof cookie only (no session), straight to payment", async () => {
  const { routes, calls } = setup();
  const started = await routes.POST(form("/session/code-start", `csrf=${CSRF}&email=buyer%40example.org&offer=${OFFER}`, `__Host-zw_csrf=${CSRF}`));
  assert.equal(started.status, 200);
  const ticket = started.headers.getSetCookie().find((c) => c.startsWith("__Host-zw_ticket="))!.split(";")[0]!;

  const verified = await routes.POST(form("/session/code-verify", `csrf=${CSRF}&code=123+456&offer=${OFFER}&expectedTotalMinor=9900`, `__Host-zw_csrf=${CSRF}; ${ticket}`));
  assert.equal(verified.status, 200);
  const text = await verified.text();
  assert.equal(JSON.parse(text).kind, "redirect");
  assert.ok(!text.includes(PROOF));
  const names = verified.headers.getSetCookie().map((c) => c.split("=")[0]);
  assert.ok(names.includes("__Host-zw_proof"));
  assert.ok(!names.includes("__Host-zw_session"));
  assert.ok(!names.includes("__Host-zw_new"));
  assert.deepEqual(calls.filter((c) => c !== "checkout/drop-off"), ["code/start", "code/verify", "checkout/quote", "checkout/start"]);
});

test("a cross-site code POST is 403 and never reaches the API", async () => {
  const { routes, calls } = setup();
  const res = await routes.POST(form("/session/code-start", `csrf=${CSRF}&email=a%40b.co`, `__Host-zw_csrf=${CSRF}`, { origin: "https://evil.example" }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("POST /session/checkout-continue answers the script-free form to the app; GET is 405", async () => {
  const { routes } = setup();
  const res = await routes.POST(form("/session/checkout-continue", `csrf=${CSRF}`, `__Host-zw_csrf=${CSRF}; __Host-zw_proof=${PROOF}`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /^text\/html/);
  const html = await res.text();
  assert.ok(html.includes(`action="${APP}/session/checkout-continue"`));
  assert.ok(html.includes(`name="nonce" value="${NONCE}"`));
  assert.ok(html.includes(">Go to my course</button>"));
  assert.equal((await routes.GET(new Request(`${ORIGIN}/session/checkout-continue`))).status, 405);
});

test("the v3.1 /session/app and /session/app-code are 404 now (AC 17)", async () => {
  const { routes } = setup();
  assert.equal((await routes.GET(new Request(`${ORIGIN}/session/app?to=%2F`))).status, 404);
  assert.equal((await routes.GET(new Request(`${ORIGIN}/session/app-code?state=${"s".repeat(43)}`))).status, 404);
});

// ---- CheckoutContinueButton, rendered in happy-dom --------------------------------------------

const window = new Window({ url: `${ORIGIN}/checkout/return/x` });
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
before(() => {
  for (const name of ["window", "document", "navigator"]) {
    saved[name] = g[name];
    Object.defineProperty(globalThis, name, { value: (window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
});
after(async () => {
  for (const [name, value] of Object.entries(saved)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  delete g.IS_REACT_ACT_ENVIRONMENT;
  await window.happyDOM.close();
});

test("CheckoutContinueButton: a form POST to the kit's route with the csrf read same-origin; nothing minted on load", async () => {
  const React = await import("react");
  const REACT_DOM_CLIENT = "react-dom/client";
  const { createRoot } = (await import(REACT_DOM_CLIENT)) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
  const { CheckoutContinueButton } = await import("../src/code-step-parts.tsx");
  const fetched: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return new Response(JSON.stringify({ formToken: CSRF, pending: null }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(CheckoutContinueButton, { next: { continueAs: "sign-up", label: "Continue sign-up", action: "/session/checkout-continue" }, fetch: fetchImpl }));
  });
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  const f = container.querySelector("form")!;
  assert.equal(f.getAttribute("method"), "post");
  assert.equal(f.getAttribute("action"), "/session/checkout-continue");
  assert.equal((container.querySelector('input[name="csrf"]') as unknown as HTMLInputElement).value, CSRF);
  const button = container.querySelector("button")!;
  assert.equal(button.textContent, "Continue sign-up");
  assert.equal((button as unknown as HTMLButtonElement).disabled, false);
  assert.deepEqual(fetched, ["/session/code-step"], "only the form value is read on load: no nonce");
  assert.equal(container.querySelector('input[name="nonce"]'), null);
  await React.act(async () => root.unmount());

  const empty = createRoot(container);
  await React.act(async () => {
    empty.render(React.createElement(CheckoutContinueButton, { next: null, fetch: fetchImpl }));
  });
  assert.equal(container.innerHTML, "");
  await React.act(async () => empty.unmount());
  container.remove();
});
