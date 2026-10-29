/**
 * useCodeStep (checkout v3.2 §8, A2) rendered for real in happy-dom with a
 * fake kit server: focus on the code input when the step opens, paste of
 * "123 456", Tab leaves the code input (no trap), errors tied to their
 * inputs, the polite live region, the terms tick box (recoverable), the
 * expired-ticket restart, the resend cap, straight to payment or "Pay
 * {amount}", and nothing of the proof in the browser.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { Window } from "happy-dom";

const window = new Window({ url: "https://www.example.org/" });
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const GLOBALS = ["window", "document", "navigator"] as const;

const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const CSRF = "c".repeat(43);
const OFFER = "6520f1c2a3b4c5d6e7f80a01";
const ORDER = "6520f1c2a3b4c5d6e7f80a04";
const TICKET = { codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: "2026-10-28T10:00:42.000Z" };
const REDIRECT = { kind: "redirect", url: "https://checkout.stripe.com/c/pay/x", orderId: ORDER, orderToken: "ot_1", orderTokenExpiresAt: null, settled: false };
const TERMS = [{ type: "terms", version: "3" }];

before(() => {
  for (const name of GLOBALS) {
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

interface Sent {
  path: string;
  form: Record<string, string>;
}

type Reply = { status: number; body: unknown };

function fakeServer(
  replies: Partial<Record<"code-verify" | "code-pay" | "code-resend" | "code-start", Reply | Reply[]>> = {},
  verifyDelayMs = 0,
  /** What each GET /session/code-step answers as `formToken`, in turn (the last one repeats). */
  formTokens: string[] = [CSRF],
) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    sent.push({ path, form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
    const reply = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/code-step")) {
      const reads = sent.filter((x) => x.path.endsWith("/code-step")).length;
      return reply({ status: 200, body: { formToken: formTokens[Math.min(reads, formTokens.length) - 1], pending: null } });
    }
    const name = path.slice(path.lastIndexOf("/") + 1) as keyof typeof replies;
    const configured = replies[name] ?? (name === "code-start" ? { status: 200, body: TICKET } : undefined);
    const r = Array.isArray(configured) ? configured[sent.filter((s) => s.path === path).length - 1] : configured;
    if (!r) return reply({ status: 404, body: {} });
    if (name === "code-verify") await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));
    return reply(r);
  }) as typeof fetch;
  return { sent, fetch: fetchImpl };
}

async function mount(server: ReturnType<typeof fakeServer>, extra: { terms?: typeof TERMS; clock?: { now: number }; country?: string; termsLater?: { current: typeof TERMS | undefined; set?: () => void } } = {}) {
  const React = await import("react");
  const { act } = React;
  const REACT_DOM_CLIENT = "react-dom/client";
  const { createRoot } = (await import(REACT_DOM_CLIENT)) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
  const { useCodeStep } = await import("../src/use-code-step.ts");
  const { CodeStepLiveRegion } = await import("../src/code-step-parts.tsx");
  const handle: { current: ReturnType<typeof useCodeStep> | null } = { current: null };
  const navigated: string[] = [];
  const stored = new Map<string, string>();
  const clock = extra.clock ?? { now: NOW };
  function Probe() {
    const [, rerender] = React.useState(0);
    if (extra.termsLater) extra.termsLater.set = () => rerender((n) => n + 1);
    const lateTerms = extra.termsLater?.current;
    const step = useCodeStep({
      fetch: server.fetch,
      now: () => clock.now,
      offer: OFFER,
      expectedTotalMinor: "9900",
      expectedCurrencyCode: "USD",
      storageKey: (id) => `example:checkout:order:${id}`,
      storage: { setItem: (k, v) => void stored.set(k, v) },
      navigate: (url) => void navigated.push(url),
      ...(extra.terms ? { terms: extra.terms } : lateTerms ? { terms: lateTerms } : {}),
      ...(extra.country ? { country: extra.country } : {}),
    });
    handle.current = step;
    const e = step.state.error;
    return React.createElement("div", null,
      React.createElement("input", { ...step.emailInputProps, defaultValue: "buyer@example.org" }),
      e?.field === "email" ? React.createElement("p", { id: step.ids.emailError }, e.message) : null,
      React.createElement("input", step.codeInputProps),
      React.createElement("p", { id: step.ids.codeHint }, "hint"),
      e?.field === "code" ? React.createElement("p", { id: step.ids.codeError, role: "alert" }, e.message) : null,
      step.state.termsRequired ? React.createElement("input", step.termsInputProps) : null,
      React.createElement("button", { id: "continue", disabled: step.busy }, "Continue"),
      React.createElement("span", { id: "resend" }, step.resendLabel),
      React.createElement("p", { id: "price" }, step.priceLine ?? ""),
      React.createElement("p", { id: "pay" }, step.payLabel ?? ""),
      React.createElement(CodeStepLiveRegion, { step }));
  }
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { act, container, handle, navigated, stored, unmount, clock };
}

const settle = (act: (fn: () => Promise<void>) => Promise<void>, ms = 5) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const q = (container: { querySelector(s: string): unknown }, sel: string) => container.querySelector(sel) as unknown as HTMLInputElement;

test("send → code step: focus moves to the code input, countdown text, the polite region says it once", async () => {
  const server = fakeServer();
  const { act, container, handle, unmount, clock } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await settle(act);
  const s = handle.current!;
  assert.equal(s.state.step, "code");
  assert.equal((window.document.activeElement as unknown) === q(container, `#${s.ids.code}`), true, "focus is on the code input");
  assert.equal(q(container, "#resend").textContent, "Send a new code in 42s");
  const region = container.querySelector('[role="status"]')!;
  assert.equal(region.getAttribute("aria-live"), "polite");
  assert.equal(region.textContent, "Send a new code in 42s");
  clock.now = NOW + 20_000;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  assert.equal(q(container, "#resend").textContent, "Send a new code in 22s");
  assert.equal(region.textContent, "Send a new code in 42s", "the region does not tick");
  clock.now = NOW + 42_000;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  assert.equal(region.textContent, "Send a new code", "announced again when ready");
  const start = server.sent.find((x) => x.path === "/session/code-start")!;
  assert.deepEqual(start.form, { csrf: CSRF, email: "buyer@example.org", offer: OFFER });
  await unmount();
});

test("paste of '123 456' fills six digits (no maxLength cuts it first); Tab is never trapped", async () => {
  const server = fakeServer();
  const { act, container, handle, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  const input = q(container, `#${handle.current!.ids.code}`);
  assert.equal(input.getAttribute("maxlength"), null);
  assert.equal(input.getAttribute("autocomplete"), "one-time-code");
  assert.equal(input.getAttribute("inputmode"), "numeric");
  // Through the input itself, as a paste lands: the input's own onChange cleans it.
  const type = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
  await type("123 456");
  assert.equal(handle.current!.code, "123456");
  assert.equal(input.value, "123456");
  await type("12 34 56 78");
  assert.equal(handle.current!.code, "123456");
  assert.equal(input.value, "123456");
  // One input, and a Tab on it is never held back: focus moves on like any other field.
  assert.equal(container.querySelectorAll(`input[name="code"]`).length, 1);
  const tab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(tab as unknown as Event);
  assert.equal(tab.defaultPrevented, false);
  await unmount();
});

test("verify, total unchanged: ONE verify with the purchase, order kept, straight to payment; 'Taking you to payment…'", async () => {
  const server = fakeServer({ "code-verify": { status: 200, body: REDIRECT } }, 30);
  const { act, container, handle, navigated, stored, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("123 456"); });
  let first: Promise<void> | undefined;
  await act(async () => {
    first = handle.current!.verify();
    void handle.current!.verify();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.equal(q(container, "#continue").disabled, true);
  await act(async () => { await first; });
  await settle(act);
  const verifies = server.sent.filter((x) => x.path === "/session/code-verify");
  assert.equal(verifies.length, 1);
  assert.deepEqual(verifies[0]!.form, { csrf: CSRF, code: "123456", offer: OFFER, expectedTotalMinor: "9900", expectedCurrencyCode: "USD" });
  assert.equal(handle.current!.state.step, "paying");
  assert.equal(container.querySelector('[role="status"]')!.textContent, "Taking you to payment…");
  assert.deepEqual(navigated, [REDIRECT.url]);
  assert.deepEqual(JSON.parse(stored.get(`example:checkout:order:${ORDER}`)!), { orderId: ORDER, token: "ot_1", email: "", coursePath: null, expiresAt: null, member: false });
  // Nothing about the proof in browser storage.
  assert.equal(window.localStorage.length, 0);
  assert.equal(window.sessionStorage.length, 0);
  await unmount();
});

test("A2: a changed total shows 'Your member price is {amount}.' and 'Pay {amount}'; Pay starts at that total", async () => {
  const server = fakeServer({
    "code-verify": { status: 200, body: { kind: "confirm-price", totalMinor: "7900", currencyCode: "USD", minorUnitExponent: 2 } },
    "code-pay": { status: 200, body: REDIRECT },
  });
  const { act, container, handle, navigated, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("123456"); });
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  assert.equal(handle.current!.state.step, "confirm-price");
  assert.equal(q(container, "#price").textContent, "Your member price is $79.00.");
  assert.equal(q(container, "#pay").textContent, "Pay $79.00");
  assert.deepEqual(navigated, []);
  await act(async () => { await handle.current!.pay(); });
  await settle(act);
  const pay = server.sent.find((x) => x.path === "/session/code-pay")!;
  assert.deepEqual(pay.form, { csrf: CSRF, offer: OFFER, expectedTotalMinor: "7900", expectedCurrencyCode: "USD" });
  assert.deepEqual(navigated, [REDIRECT.url]);
  await unmount();
});

test("a wrong code stays on the step, the line is tied to the code input, focus goes back to it", async () => {
  const server = fakeServer({ "code-verify": { status: 400, body: { reason: "WEBSITE_CODE_INVALID" } } });
  const { act, container, handle, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  q(container, "#continue").focus();
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  const s = handle.current!;
  assert.equal(s.state.step, "code");
  const input = q(container, `#${s.ids.code}`);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.deepEqual(input.getAttribute("aria-describedby")!.split(" "), [s.ids.codeError, s.ids.codeHint]);
  assert.equal(q(container, `#${s.ids.codeError}`).textContent, "That code isn't right. Check it and try again, or send a new code.");
  assert.equal((window.document.activeElement as unknown) === input, true);
  await unmount();
});

test("an invalid email at start: 'Enter a valid email address.' tied to the email input", async () => {
  const server = fakeServer({ "code-start": { status: 400, body: { reason: "WEBSITE_CODE_EMAIL_INVALID" } } });
  const { act, container, handle, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("nope"); });
  await settle(act);
  const s = handle.current!;
  assert.equal(s.state.step, "email");
  const email = q(container, `#${s.ids.email}`);
  assert.equal(email.getAttribute("aria-invalid"), "true");
  assert.equal(email.getAttribute("aria-describedby"), s.ids.emailError);
  assert.equal(q(container, `#${s.ids.emailError}`).textContent, "Enter a valid email address.");
  await unmount();
});

test("terms: the tick box shows, Continue without it is recoverable (no call), ticking sends acceptedDocuments", async () => {
  const server = fakeServer({ "code-verify": { status: 200, body: REDIRECT } });
  const { act, container, handle, unmount } = await mount(server, { terms: TERMS });
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("123456"); });
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  const s = handle.current!;
  assert.equal(s.state.step, "code");
  assert.equal(s.state.error?.field, "terms");
  assert.equal(server.sent.filter((x) => x.path === "/session/code-verify").length, 0);
  const box = q(container, `#${s.ids.terms}`);
  assert.equal(box.getAttribute("aria-invalid"), "true");
  assert.equal((window.document.activeElement as unknown) === box, true, "focus on the tick box");
  await act(async () => { handle.current!.setTermsAccepted(true); });
  assert.equal(handle.current!.state.error, null);
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  const v = server.sent.find((x) => x.path === "/session/code-verify")!;
  assert.equal(v.form.acceptedDocuments, JSON.stringify(TERMS));
  await unmount();
});

test("WEBSITE_TERMS_REQUIRED from the API shows the tick box and keeps the step (recoverable)", async () => {
  const server = fakeServer({ "code-verify": [{ status: 400, body: { reason: "WEBSITE_TERMS_REQUIRED", fields: ["acceptedDocuments"] } }, { status: 200, body: REDIRECT }] });
  const { act, container, handle, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("123456"); });
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  assert.equal(handle.current!.state.step, "code");
  assert.equal(handle.current!.state.termsRequired, true);
  assert.ok(container.querySelector(`#${handle.current!.ids.terms}`));
  await unmount();
});

test("the resend cap (E5): its own line with the wait", async () => {
  const server = fakeServer({ "code-resend": { status: 429, body: { reason: "WEBSITE_CODE_LOCKED", retryAfterSeconds: 600 } } });
  const clock = { now: NOW };
  const { act, handle, unmount } = await mount(server, { clock });
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  clock.now = NOW + 43_000;
  await settle(act, 1100);
  await act(async () => { await handle.current!.resend(); });
  await settle(act);
  assert.equal(handle.current!.state.error?.message, "You've asked for the most codes we can send for now. Try again in 10 min, or use a different email.");
  assert.equal(handle.current!.canResend, false);
  await unmount();
});

test("§8: the ticket gone altogether, 'Send a new code' starts again with the stored email", async () => {
  const server = fakeServer({ "code-resend": { status: 400, body: { reason: "WEBSITE_CODE_EXPIRED" } } });
  const clock = { now: NOW };
  const { act, handle, unmount } = await mount(server, { clock });
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  clock.now = NOW + 43_000;
  await settle(act, 1100);
  await act(async () => { await handle.current!.resend(); });
  await settle(act);
  const starts = server.sent.filter((x) => x.path === "/session/code-start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1]!.form.email, "buyer@example.org");
  assert.equal(handle.current!.state.step, "code");
  assert.equal(handle.current!.state.error, null);
  await unmount();
});

test("locked shows the wait in minutes", async () => {
  const server = fakeServer({ "code-verify": { status: 429, body: { reason: "WEBSITE_CODE_LOCKED", retryAfterSeconds: 300 } } });
  const { act, container, handle, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("000000"); });
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  assert.equal(q(container, `#${handle.current!.ids.codeError}`).textContent, "Too many tries. Try again in 5 min.");
  await unmount();
});

test("country: the page's priced-in country is posted with verify and pay", async () => {
  const COUNTRY_ID = "6520f1c2a3b4c5d6e7f80a05";
  const server = fakeServer({
    "code-verify": { status: 200, body: { kind: "confirm-price", totalMinor: "7900", currencyCode: "USD", minorUnitExponent: 2 } },
    "code-pay": { status: 200, body: REDIRECT },
  });
  const { act, handle, unmount } = await mount(server, { country: COUNTRY_ID });
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("123456"); });
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  await act(async () => { await handle.current!.pay(); });
  await settle(act);
  assert.equal(server.sent.find((x) => x.path === "/session/code-verify")!.form.country, COUNTRY_ID);
  assert.equal(server.sent.find((x) => x.path === "/session/code-pay")!.form.country, COUNTRY_ID);
  await unmount();
});

test("a stale form value (403 from the kit, nothing spent) is read again and the POST sent ONCE more with the fresh one", async () => {
  const FRESH = "d".repeat(43);
  const server = fakeServer({ "code-verify": [{ status: 403, body: {} }, { status: 200, body: REDIRECT }] }, 0, [CSRF, FRESH]);
  const { act, handle, navigated, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("123456"); });
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  const verifies = server.sent.filter((x) => x.path === "/session/code-verify");
  assert.deepEqual(verifies.map((v) => v.form.csrf), [CSRF, FRESH]);
  assert.equal(handle.current!.state.step, "paying");
  assert.deepEqual(navigated, [REDIRECT.url]);
  await unmount();
});

test("a 403 that a fresh read does not cure is not retried again: the generic line", async () => {
  const server = fakeServer({ "code-verify": { status: 403, body: {} } });
  const { act, handle, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("123456"); });
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  assert.equal(server.sent.filter((x) => x.path === "/session/code-verify").length, 1, "the same value again would be refused again");
  assert.equal(handle.current!.state.error?.reason, "UNAVAILABLE");
  await unmount();
});

test("a redirect answer whose url is not http(s) is never followed: the generic line, nothing stored", async () => {
  for (const url of ["javascript:alert(1)", "/checkout/return/x"]) {
    const server = fakeServer({ "code-verify": { status: 200, body: { ...REDIRECT, url } } });
    const { act, handle, navigated, stored, unmount } = await mount(server);
    await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
    await act(async () => { handle.current!.setCode("123456"); });
    await act(async () => { await handle.current!.verify(); });
    await settle(act);
    assert.deepEqual(navigated, [], url);
    assert.equal(stored.size, 0);
    assert.equal(handle.current!.state.error?.reason, "UNAVAILABLE");
    await unmount();
  }
});

test("a failed 'Pay {amount}' is tied to the payment line (field 'payment'), and Pay can be pressed again", async () => {
  const server = fakeServer({
    "code-verify": { status: 200, body: { kind: "confirm-price", totalMinor: "7900", currencyCode: "USD", minorUnitExponent: 2 } },
    "code-pay": [{ status: 200, body: { kind: "payment-failed", reason: "UNAVAILABLE" } }, { status: 200, body: REDIRECT }],
  });
  const { act, handle, navigated, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("123456"); });
  await act(async () => { await handle.current!.verify(); });
  await settle(act);
  await act(async () => { await handle.current!.pay(); });
  await settle(act);
  assert.equal(handle.current!.state.step, "pay-failed");
  assert.equal(handle.current!.state.error?.field, "payment");
  assert.equal(handle.current!.payLabel, "Pay $79.00", "the retry still says what it pays");
  await act(async () => { await handle.current!.pay(); });
  await settle(act);
  assert.deepEqual(navigated, [REDIRECT.url]);
  await unmount();
});

test("a 200 from code-start that is not a ticket (a proxy page, a version skew) is no answer: the step stays usable", async () => {
  const server = fakeServer({ "code-start": [{ status: 200, body: { codeLength: "six" } }, { status: 200, body: TICKET }] });
  const { act, handle, unmount } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  assert.equal(handle.current!.state.step, "email");
  assert.equal(handle.current!.state.error?.reason, "UNAVAILABLE");
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  assert.equal(handle.current!.state.step, "code");
  await act(async () => { handle.current!.setCode("123456"); });
  assert.equal(handle.current!.code, "123456", "the code length is a real one");
  await unmount();
});

test("terms that arrive after the first render (loaded later) still show the tick box and still guard Continue", async () => {
  const server = fakeServer({ "code-verify": { status: 200, body: REDIRECT } });
  const late: { current: typeof TERMS | undefined; set?: () => void } = { current: undefined };
  const { act, handle, unmount } = await mount(server, { termsLater: late });
  assert.equal(handle.current!.state.termsRequired, false);
  await act(async () => { late.current = TERMS; late.set!(); });
  assert.equal(handle.current!.state.termsRequired, true);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { handle.current!.setCode("123456"); });
  await act(async () => { await handle.current!.verify(); });
  assert.equal(handle.current!.state.error?.reason, "WEBSITE_TERMS_REQUIRED");
  assert.equal(server.sent.filter((x) => x.path === "/session/code-verify").length, 0, "no guess spent");
  await unmount();
});
