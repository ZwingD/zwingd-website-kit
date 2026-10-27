/**
 * kit #10 / #11 in the header: the sign-out form carries this page as `next`;
 * "Go to my account" opens the `accountPath` prop, else the provider's
 * `accountUrl` (the workspace's landing path), else the app's home; and
 * `useCourseUrl` gives the owned-course panel the course page or the learning page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createElement } from "react";

import { AccountButton } from "../src/account-button.tsx";
import { MemberProvider, useCourseUrl } from "../src/member-provider.tsx";
import { readSessionMe } from "../src/session-me.ts";

const REACT_DOM_SERVER = "react-dom/server";
const { renderToStaticMarkup } = (await import(REACT_DOM_SERVER)) as { renderToStaticMarkup(element: unknown): string };

const APP = "https://app.example.org";
const SIGNED_IN = { member: { firstName: "Asha" }, signOutToken: "t".repeat(43) };

const render = (provider: Record<string, unknown>, props: Record<string, unknown> = {}, child?: unknown) =>
  renderToStaticMarkup(
    createElement(MemberProvider as never, { appUrl: APP, ...provider } as never, (child ?? createElement(AccountButton, props as never)) as never),
  );

const accountHref = (html: string) => /<a href="([^"]*)">Go to my account<\/a>/.exec(html)?.[1];

test("sign-out form: carries the page as next", () => {
  const html = render(SIGNED_IN, { next: "/courses/afscm" });
  assert.match(html, /<input type="hidden" name="next" value="\/courses\/afscm"\/>/);
});

test("sign-out form: an unsafe next is not sent (the member returns to /)", () => {
  for (const next of ["//evil.example", "https://x", "/\\evil"]) assert.doesNotMatch(render(SIGNED_IN, { next }), /name="next"/);
});

test("Go to my account: the provider's accountUrl (the workspace's landing path)", () => {
  assert.equal(accountHref(render({ ...SIGNED_IN, accountUrl: `${APP}/communities` })), `${APP}/communities`);
});

test("Go to my account: without one, the app's home as before", () => {
  assert.equal(accountHref(render(SIGNED_IN)), `${APP}/`);
});

test("Go to my account: the accountPath prop overrides the workspace's path; an unsafe one is ignored", () => {
  assert.equal(accountHref(render({ ...SIGNED_IN, accountUrl: `${APP}/communities` }, { accountPath: "/communities/learning" })), `${APP}/communities/learning`);
  assert.equal(accountHref(render({ ...SIGNED_IN, accountUrl: `${APP}/communities` }, { accountPath: "//evil.example" })), `${APP}/communities`);
});

test("client mode: /session/me's accountUrl is read; anything not http(s) is dropped", () => {
  assert.equal(readSessionMe({ member: { firstName: "A" }, signOutToken: "t", accountUrl: `${APP}/communities` }).accountUrl, `${APP}/communities`);
  for (const bad of ["javascript:alert(1)", "/communities", 42, null]) {
    assert.equal(readSessionMe({ member: { firstName: "A" }, signOutToken: "t", accountUrl: bad }).accountUrl, null);
  }
});

function CourseLink({ code }: { code: string }) {
  return createElement("a", { href: useCourseUrl()(code) }, "Go to my course");
}

test("useCourseUrl: the course page with coursePath, else the learning page", () => {
  const withPage = render({ ...SIGNED_IN, coursePath: "/communities/courses/:code" }, {}, createElement(CourseLink, { code: "CRS-1" }));
  assert.match(withPage, new RegExp(`href="${APP}/communities/courses/CRS-1"`));
  const without = render({ mode: "client" }, {}, createElement(CourseLink, { code: "CRS-1" }));
  assert.match(without, new RegExp(`href="${APP}/communities/learning"`));
});
