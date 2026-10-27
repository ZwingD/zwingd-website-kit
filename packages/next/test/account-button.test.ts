/**
 * AccountButton takes a class name on every part it draws (Iris on KIT-2,
 * note 2), so a site's header can style each one: the loading placeholder, the
 * Log in link, the My account trigger, the menu, each menu item, and the
 * sign-out form and its button.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createElement } from "react";

import { AccountButton } from "../src/account-button.tsx";
import { MemberProvider } from "../src/member-provider.tsx";

// react-dom ships no types here (no @types/react-dom in the workspace): read the one function used.
const REACT_DOM_SERVER = "react-dom/server";
const { renderToStaticMarkup } = (await import(REACT_DOM_SERVER)) as { renderToStaticMarkup(element: unknown): string };

const CLASSES = {
  className: "c-root",
  loadingClassName: "c-loading",
  logInClassName: "c-login",
  triggerClassName: "c-trigger",
  menuClassName: "c-menu",
  itemClassName: "c-item",
  signOutFormClassName: "c-signout-form",
  signOutClassName: "c-signout",
};

function render(provider: Record<string, unknown>, props: Record<string, unknown> = CLASSES): string {
  return renderToStaticMarkup(
    createElement(MemberProvider as never, { appUrl: "https://app.example.org", ...provider } as never, createElement(AccountButton, props as never))
  );
}

test("signed out: the Log in link takes logInClassName", () => {
  const html = render({ member: null, signOutToken: null });
  assert.match(html, /<a class="c-login" href="\/session\/start\?next=%2F">Log in<\/a>/);
});

test("signed in: the root, the My account trigger, the menu, each item, the form and the button take their classes", () => {
  const html = render({ member: { firstName: "Asha" }, signOutToken: "t".repeat(43) });
  assert.match(html, /<details class="c-root">/);
  assert.match(html, /<summary class="c-trigger">My account<\/summary>/);
  assert.match(html, /<div class="c-menu">/);
  assert.match(html, /<a class="c-item" href="https:\/\/app\.example\.org\/">Go to my account<\/a>/);
  // React orders a form's attributes its own way: match the class and the target, not their order.
  assert.match(html, /<form class="c-signout-form"[^>]*action="\/session\/end"/);
  assert.match(html, /<button class="c-signout" type="submit">Sign out<\/button>/);
});

test("client mode before /session/me answers: the placeholder takes loadingClassName", () => {
  const html = render({ mode: "client" });
  assert.match(html, /<span class="c-loading" aria-busy="true"><\/span>/);
});

test("without the part-specific names, every part falls back as before (className, itemClassName)", () => {
  const legacy = { className: "c-root", menuClassName: "c-menu", itemClassName: "c-item" };
  assert.match(render({ member: null, signOutToken: null }, legacy), /<a class="c-root" href=/);
  assert.match(render({ mode: "client" }, legacy), /<span class="c-root" aria-busy="true">/);
  const signedIn = render({ member: { firstName: "Asha" }, signOutToken: "t".repeat(43) }, legacy);
  assert.match(signedIn, /<button class="c-item" type="submit">Sign out<\/button>/);
});
