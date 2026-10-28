/**
 * useCodeStep (checkout v3.1, plan K3) rendered for real in happy-dom with a
 * fake kit server: focus on the code input, Continue off while a verify is in
 * flight (one verify per submit), the countdown text, and the notice never
 * stored.
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
const TICKET = { codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: "2026-10-28T10:00:42.000Z" };

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

function fakeServer(verifyReply: { status: number; body: unknown }, verifyDelayMs = 0) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    sent.push({ path, form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/code-step")) return reply(200, { formToken: CSRF, pending: null });
    if (path.endsWith("/code-start")) return reply(200, TICKET);
    if (path.endsWith("/code-verify")) {
      await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));
      return reply(verifyReply.status, verifyReply.body);
    }
    return reply(404, {});
  }) as typeof fetch;
  return { sent, fetch: fetchImpl };
}

async function mount(server: ReturnType<typeof fakeServer>) {
  const React = await import("react");
  const { act } = React;
  const REACT_DOM_CLIENT = "react-dom/client";
  const { createRoot } = (await import(REACT_DOM_CLIENT)) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
  const { useCodeStep } = await import("../src/use-code-step.ts");
  const handle: { current: ReturnType<typeof useCodeStep> | null } = { current: null };
  function Probe() {
    const step = useCodeStep({ fetch: server.fetch, now: () => NOW, offer: "6520f1c2a3b4c5d6e7f80a01" });
    handle.current = step;
    return React.createElement("div", null,
      React.createElement("input", { ref: step.codeInputRef, id: "code", autoComplete: "one-time-code" }),
      React.createElement("button", { id: "continue", disabled: step.busy }, "Continue"),
      React.createElement("span", { id: "resend" }, step.resendLabel),
      React.createElement("p", { id: "error", role: "alert" }, step.state.error?.message ?? ""));
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
  return { act, container, root, handle };
}

const settle = (act: (fn: () => Promise<void>) => Promise<void>, ms = 5) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test("send → code step: focus on the code input, countdown text, the form value sent as csrf", async () => {
  const server = fakeServer({ status: 200, body: { member: {}, notice: null, signOutToken: CSRF } });
  const { act, container, root, handle } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await settle(act);
  assert.equal(handle.current!.state.step, "code");
  assert.equal(window.document.activeElement === container.querySelector("#code"), true, "focus is on the code input");
  assert.equal(container.querySelector("#resend")!.textContent, "Send a new code in 42s");
  const start = server.sent.find((s) => s.path === "/session/code-start")!;
  assert.deepEqual(start.form, { csrf: CSRF, email: "buyer@example.org", offer: "6520f1c2a3b4c5d6e7f80a01" });
  await act(async () => root.unmount());
  container.remove();
});

test("Continue is disabled in flight and a double submit sends ONE verify", async () => {
  const server = fakeServer({ status: 200, body: { member: { firstName: "Asha" }, notice: "account-ready", signOutToken: CSRF } }, 30);
  const { act, container, root, handle } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  let first: Promise<void> | undefined;
  await act(async () => {
    first = handle.current!.verify("123456");
    void handle.current!.verify("123456");
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.equal((container.querySelector("#continue") as unknown as { disabled: boolean }).disabled, true);
  await act(async () => { await first; });
  await settle(act);
  assert.equal(server.sent.filter((s) => s.path === "/session/code-verify").length, 1);
  assert.equal(handle.current!.state.step, "verified");
  assert.equal(handle.current!.state.notice, "account-ready");
  // Display only: nothing stored in the browser.
  assert.equal(window.localStorage.length, 0);
  assert.equal(window.sessionStorage.length, 0);
  await act(async () => root.unmount());
  container.remove();
});

test("a wrong code stays on the step with the spec's line and focus back on the input", async () => {
  const server = fakeServer({ status: 400, body: { reason: "WEBSITE_CODE_INVALID" } });
  const { act, container, root, handle } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  (container.querySelector("#continue") as unknown as HTMLElement).focus();
  await act(async () => { await handle.current!.verify("000000"); });
  await settle(act);
  assert.equal(handle.current!.state.step, "code");
  assert.equal(container.querySelector("#error")!.textContent, "That code isn't right. Check it and try again, or send a new code.");
  assert.equal(window.document.activeElement === container.querySelector("#code"), true);
  await act(async () => root.unmount());
  container.remove();
});

test("locked shows the wait in minutes", async () => {
  const server = fakeServer({ status: 429, body: { reason: "WEBSITE_CODE_LOCKED", retryAfterSeconds: 300 } });
  const { act, container, root, handle } = await mount(server);
  await act(async () => { await handle.current!.sendCode("buyer@example.org"); });
  await act(async () => { await handle.current!.verify("000000"); });
  await settle(act);
  assert.equal(container.querySelector("#error")!.textContent, "Too many tries. Try again in 5 min.");
  await act(async () => root.unmount());
  container.remove();
});
