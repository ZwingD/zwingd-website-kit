/**
 * The ONE same-site POST rule behind POST /session/end and POST
 * /session/checkout: no cross-site Origin or Sec-Fetch-Site, and the
 * `SameSite=Strict` CSRF cookie's value in the form.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sameSitePost } from "../src/same-site.ts";
import { ORIGIN, req } from "./helpers.ts";

const CSRF = "c".repeat(43);
const rule = { origin: ORIGIN, csrfCookie: "__Host-zw_csrf" };
const post = (over: Partial<Parameters<typeof req>[0]> = {}) =>
  req({ method: "POST", url: `${ORIGIN}/session/end`, cookies: { "__Host-zw_csrf": CSRF }, headers: { origin: ORIGIN }, form: { csrf: CSRF }, ...over });

test("a same-origin POST with the cookie's value in the form passes", () => {
  assert.equal(sameSitePost(post(), rule), true);
  assert.equal(sameSitePost(post({ headers: { "sec-fetch-site": "same-origin" } }), rule), true);
  assert.equal(sameSitePost(post({ headers: { Origin: ORIGIN } }), rule), true);
  // No Origin and no Sec-Fetch-Site (an older browser): the CSRF value alone decides.
  assert.equal(sameSitePost(post({ headers: {} }), rule), true);
});

test("a cross-site Origin or Sec-Fetch-Site, or a missing, short or different value, fails", () => {
  for (const view of [
    post({ headers: { origin: "https://evil.example" } }),
    post({ headers: { origin: "null" } }),
    post({ headers: { "sec-fetch-site": "cross-site" } }),
    post({ headers: { "sec-fetch-site": "same-site" } }),
    post({ form: {} }),
    post({ form: { csrf: "d".repeat(43) } }),
    post({ cookies: {} }),
    post({ cookies: { "__Host-zw_csrf": "short" }, form: { csrf: "short" } }),
  ]) {
    assert.equal(sameSitePost(view, rule), false);
  }
});
