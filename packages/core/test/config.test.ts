/** The server settings: checked once, and never echoed in an error. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { configFromEnv, resolveConfig, WebsiteKitConfigError } from "../src/config.ts";
import { API, APP, ORIGIN, SECRET } from "./helpers.ts";

const good = { apiUrl: API, appUrl: `${APP}/`, realm: "acme", clientSecret: SECRET, origin: ORIGIN };

test("accepts the contract's shapes and drops a trailing slash", () => {
  const config = resolveConfig(good);
  assert.equal(config.appUrl, APP);
  assert.equal(config.timeoutMs, 10_000);
  assert.equal(config.insecureLocalCookies, false);
});

for (const [setting, over] of [
  ["ZWINGD_SESSION_CLIENT_SECRET", { clientSecret: "zsh_short" }],
  ["ZWINGD_SITE_ORIGIN", { origin: "https://www.example.org/" }],
  ["ZWINGD_SITE_ORIGIN", { origin: "http://www.example.org" }],
  ["ZWINGD_SITE_ORIGIN", { origin: "https://WWW.example.org" }],
  ["ZWINGD_API_URL", { apiUrl: "http://api.example.com" }],
  ["ZWINGD_APP_URL", { appUrl: "https://user:pw@app.example.org" }],
  ["ZWINGD_REALM", { realm: "" }],
] as const) {
  test(`refuses a bad ${setting} (${JSON.stringify(over)})`, () => {
    assert.throws(() => resolveConfig({ ...good, ...over }), (err: unknown) => err instanceof WebsiteKitConfigError && err.setting === setting);
  });
}

test("an error never carries the client secret", () => {
  const secretLike = "zsh_" + "f".repeat(63) + "Z";
  try {
    resolveConfig({ ...good, clientSecret: secretLike });
    assert.fail("should refuse");
  } catch (err) {
    assert.equal(String((err as Error).message).includes(secretLike), false);
    assert.equal(JSON.stringify(err).includes(secretLike), false);
  }
});

test("insecureLocalCookies is refused when NODE_ENV=production, and allows http://localhost otherwise", () => {
  const local = { apiUrl: "http://localhost:3000", appUrl: "http://localhost:4200", realm: "acme", clientSecret: SECRET, origin: "http://localhost:3100", insecureLocalCookies: true };
  const before = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.throws(() => resolveConfig(local), WebsiteKitConfigError);
    process.env.NODE_ENV = "development";
    assert.equal(resolveConfig(local).origin, "http://localhost:3100");
    assert.throws(() => resolveConfig({ ...local, origin: "http://www.example.org" }), WebsiteKitConfigError);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
});

test("configFromEnv reads the standard names", () => {
  const config = configFromEnv({ ZWINGD_API_URL: API, ZWINGD_APP_URL: APP, ZWINGD_REALM: "acme", ZWINGD_SESSION_CLIENT_SECRET: SECRET, ZWINGD_SITE_ORIGIN: ORIGIN });
  assert.equal(config.realm, "acme");
  assert.throws(() => configFromEnv({}), WebsiteKitConfigError);
});
