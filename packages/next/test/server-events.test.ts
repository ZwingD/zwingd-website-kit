/**
 * The Server Component / route handler helpers for member events read the
 * session cookie through `next/headers` and hand it to the core, as
 * `getMemberQuote` does.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

const TOKEN = "e".repeat(64);
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ getAll: () => [{ name: "__Host-zw_session", value: TOKEN }, { name: "other", value: "x" }] }),
  },
});

const { getMemberEvent, registerMemberEvent } = await import("../src/server.ts");

test("getMemberEvent(events, slug) passes the request's cookies and the slug to the core", async () => {
  const seen: unknown[] = [];
  const events = {
    getMemberEvent: async (cookies: Record<string, string>, slug: string) => {
      seen.push({ cookies, slug });
      return { status: "ended" as const };
    },
    registerMemberEvent: async () => ({ status: "unavailable" as const }),
  };
  assert.deepEqual(await getMemberEvent(events, "codeclick-test"), { status: "ended" });
  assert.deepEqual(seen, [{ cookies: { "__Host-zw_session": TOKEN, other: "x" }, slug: "codeclick-test" }]);
});

test("registerMemberEvent(events, slug, registration) passes the cookies, the slug and the registration", async () => {
  const seen: unknown[] = [];
  const events = {
    getMemberEvent: async () => ({ status: "unavailable" as const }),
    registerMemberEvent: async (cookies: Record<string, string>, slug: string, registration?: unknown) => {
      seen.push({ cookies, slug, registration });
      return { status: "ok" as const, seat: "REGISTERED" as const };
    },
  };
  const registration = { consents: [{ key: "terms", accepted: true, wordingVersion: "v1" }] };
  assert.deepEqual(await registerMemberEvent(events, "codeclick-test", registration), { status: "ok", seat: "REGISTERED" });
  assert.deepEqual(seen, [{ cookies: { "__Host-zw_session": TOKEN, other: "x" }, slug: "codeclick-test", registration }]);
});
