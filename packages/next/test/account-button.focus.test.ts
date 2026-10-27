/**
 * kit #5 (Iris): when a retry turns a focused "Log in" into "My account", focus
 * moves to "My account", so a keyboard user is not left on a removed element.
 * Rendered for real in happy-dom, with a fake /session/me.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { Window } from "happy-dom";

const window = new Window({ url: "https://www.example.org/" });
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
// Only what react-dom reads: replacing Node's own Event or EventTarget would break the test runner.
const GLOBALS = ["window", "document", "navigator"] as const;

let replies: Array<{ status: number; body?: unknown }> = [];
let fetchCalls = 0;

before(() => {
  for (const name of GLOBALS) {
    saved[name] = g[name];
    Object.defineProperty(globalThis, name, { value: (window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  saved.fetch = g.fetch;
  g.fetch = async () => {
    const reply = replies[Math.min(fetchCalls, replies.length - 1)]!;
    fetchCalls += 1;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

after(async () => {
  for (const [name, value] of Object.entries(saved)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  delete g.IS_REACT_ACT_ENVIRONMENT;
  await window.happyDOM.close();
});

async function mount() {
  const React = await import("react");
  const { act } = React;
  const REACT_DOM_CLIENT = "react-dom/client";
  const { createRoot } = (await import(REACT_DOM_CLIENT)) as { createRoot(el: unknown): { render(n: unknown): void; unmount(): void } };
  const { AccountButton } = await import("../src/account-button.tsx");
  const { MemberProvider } = await import("../src/member-provider.tsx");
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(MemberProvider as never, { mode: "client", appUrl: "https://app.example.org" } as never, React.createElement(AccountButton, { triggerClassName: "trigger" } as never))
    );
  });
  // Let the first /session/me read settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return { act, container, root };
}

test("a focused Log in that a retry turns into My account hands focus to My account", async () => {
  replies = [{ status: 500 }, { status: 200, body: { member: { firstName: "Asha" }, signOutToken: "t".repeat(43) } }];
  fetchCalls = 0;
  const { act, container, root } = await mount();
  const logIn = container.querySelector("a") as unknown as HTMLElement;
  assert.equal(logIn.textContent, "Log in");

  await act(async () => {
    logIn.focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  const trigger = container.querySelector("summary.trigger");
  assert.equal(trigger !== null, true, "My account is shown");
  assert.equal(trigger?.textContent, "My account");
  // Compared as a boolean: a failing assert would print the DOM node, which node:test cannot finish inspecting.
  assert.equal(window.document.activeElement === trigger, true, "focus is on My account");
  assert.equal(fetchCalls, 2);
  await act(async () => root.unmount());
  container.remove();
});

test("no focus is taken when the visitor has already moved on", async () => {
  replies = [{ status: 500 }, { status: 200, body: { member: { firstName: "Asha" }, signOutToken: "t".repeat(43) } }];
  fetchCalls = 0;
  const { act, container, root } = await mount();
  const elsewhere = window.document.createElement("button");
  window.document.body.appendChild(elsewhere);
  const logIn = container.querySelector("a") as unknown as HTMLElement;

  await act(async () => {
    logIn.focus();
    // The visitor tabs on before the retry answers.
    (elsewhere as unknown as HTMLElement).focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  assert.equal(container.querySelector("summary.trigger") !== null, true);
  assert.equal(window.document.activeElement === elsewhere, true, "focus stays where the visitor put it");
  await act(async () => root.unmount());
  container.remove();
  elsewhere.remove();
});
