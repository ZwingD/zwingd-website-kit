/**
 * kit #11: "Go to my account" opens the workspace's own landing path
 * (`signInOptions.landingPath`, identity's public read), unless the site sets
 * `accountPath`; any failure is `/`. A course link opens `coursePath` with the
 * code, else the learning page. /session/me carries `accountUrl`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { courseUrlFor, LANDING_PATH_CACHE_MS, LEARNING_PATH } from "../src/account.ts";
import { WebsiteKitConfigError } from "../src/config.ts";
import { createWebsiteKit } from "../src/flows.ts";
import { API, APP, CODE, jar, ORIGIN, req, SECRET, TOKEN } from "./helpers.ts";

type GraphqlReply = { status: number; body?: unknown } | "network";

/** A fetch that answers the public signInOptions read, and the hand-over calls a sign-in needs. */
function api(graphql: GraphqlReply[]) {
  const reads: { realm: string | null; authorization: string | null; query: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === `${API}/graphql`) {
      reads.push({ realm: headers.get("realm"), authorization: headers.get("authorization"), query: JSON.parse(String(init?.body)).query });
      const reply = graphql[Math.min(reads.length - 1, graphql.length - 1)]!;
      if (reply === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(reply.body ?? null), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/exchange")) {
      return new Response(JSON.stringify({ sessionToken: TOKEN, expiresAt: "2026-10-27T18:00:00.000Z", member: { id: "6520f1c2a3b4c5d6e7f80912", firstName: "Asha" } }), { status: 200 });
    }
    if (url.endsWith("/session")) return new Response(JSON.stringify({ active: true, member: { id: "6520f1c2a3b4c5d6e7f80912", firstName: "Asha" }, expiresAt: "2026-10-27T18:00:00.000Z" }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { reads, fetch: fetchImpl };
}

const landing = (landingPath: unknown): GraphqlReply => ({ status: 200, body: { data: { signInOptions: { landingPath } } } });

function kitWith(graphql: GraphqlReply[], extra: { accountPath?: string; coursePath?: string; clock?: { now: number } } = {}) {
  const fake = api(graphql);
  const clock = extra.clock ?? { now: Date.parse("2026-10-27T10:00:00.000Z") };
  const kit = createWebsiteKit({
    apiUrl: API,
    appUrl: APP,
    realm: "scpmiStage",
    clientSecret: SECRET,
    origin: ORIGIN,
    fetch: fake.fetch,
    now: () => clock.now,
    ...(extra.accountPath ? { accountPath: extra.accountPath } : {}),
    ...(extra.coursePath ? { coursePath: extra.coursePath } : {}),
  });
  return { kit, reads: fake.reads, clock };
}

test("default: the workspace's own landing path, read publicly with the realm header and no token", async () => {
  const { kit, reads } = kitWith([landing("/communities")]);
  assert.equal(await kit.accountUrl(), `${APP}/communities`);
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.realm, "scpmiStage");
  assert.equal(reads[0]!.authorization, null);
  assert.match(reads[0]!.query, /signInOptions\s*\{\s*landingPath\s*\}/);
});

test("the landing path is cached about 5 minutes, then read again", async () => {
  const { kit, reads, clock } = kitWith([landing("/communities"), landing("/communities/learning")]);
  assert.equal(await kit.accountUrl(), `${APP}/communities`);
  clock.now += LANDING_PATH_CACHE_MS - 1;
  assert.equal(await kit.accountUrl(), `${APP}/communities`);
  assert.equal(reads.length, 1);
  clock.now += 2;
  assert.equal(await kit.accountUrl(), `${APP}/communities/learning`);
  assert.equal(reads.length, 2);
});

test("a null landing path (the app's own landing) is /", async () => {
  const { kit } = kitWith([landing(null)]);
  assert.equal(await kit.accountUrl(), `${APP}/`);
});

for (const [label, reply] of [
  ["a network failure", "network"],
  ["a 500", { status: 500, body: {} }],
  ["a GraphQL error (not public yet)", { status: 200, body: { errors: [{ message: "Unauthorized" }], data: null } }],
  ["an unsafe landing path", landing("//evil.example")],
  ["a landing path that is not a path", landing("https://evil.example/")],
] as const) {
  test(`on ${label}, "Go to my account" opens the app at /`, async () => {
    const { kit } = kitWith([reply as GraphqlReply]);
    assert.equal(await kit.accountUrl(), `${APP}/`);
  });
}

test("accountPath overrides the workspace's landing path, and nothing is read", async () => {
  const { kit, reads } = kitWith([landing("/communities")], { accountPath: "/communities/learning" });
  assert.equal(await kit.accountUrl(), `${APP}/communities/learning`);
  assert.equal(reads.length, 0);
});

test("an unsafe accountPath or coursePath is refused at start-up, naming the setting", () => {
  for (const [setting, value] of [
    ["accountPath", "//evil.example"],
    ["accountPath", "https://x"],
    ["coursePath", "/courses"],
    ["coursePath", "//evil/:code"],
  ] as const) {
    assert.throws(
      () => kitWith([], { [setting]: value }),
      (err: unknown) => err instanceof WebsiteKitConfigError && err.setting === setting && !err.message.includes(value),
    );
  }
});

test("/session/me carries accountUrl while signed in, null when signed out", async () => {
  const { kit } = kitWith([landing("/communities")]);
  const signedOut = await kit.me(req({ url: `${ORIGIN}/session/me`, headers: { "sec-fetch-site": "same-origin" } }));
  assert.equal(JSON.parse(signedOut.body!).accountUrl, null);

  const start = await kit.start(req({ url: `${ORIGIN}/session/start` }));
  const state = new URL(start.headers.Location!).searchParams.get("state")!;
  const cb = await kit.callback(req({ url: `${ORIGIN}/session/callback?code=${CODE}&state=${state}`, cookies: jar(start.setCookies) }));
  const me = await kit.me(req({ url: `${ORIGIN}/session/me`, cookies: jar(cb.setCookies), headers: { "sec-fetch-site": "same-origin" } }));
  const body = JSON.parse(me.body!);
  assert.equal(body.member.firstName, "Asha");
  assert.equal(body.accountUrl, `${APP}/communities`);
});

test("courseUrl: coursePath with the code when the site names a course page", () => {
  const { kit } = kitWith([], { coursePath: "/communities/courses/:code" });
  assert.equal(kit.courseUrl("CRS-1234"), `${APP}/communities/courses/CRS-1234`);
});

test("courseUrl: without a course page, or with a code that is not a course code, the learning page", () => {
  const { kit } = kitWith([]);
  assert.equal(kit.courseUrl("CRS-1234"), `${APP}${LEARNING_PATH}`);
  const withPage = kitWith([], { coursePath: "/communities/courses/:code" }).kit;
  for (const bad of ["../admin", "a/b", "", "x?y=1", "%2F"]) assert.equal(withPage.courseUrl(bad), `${APP}${LEARNING_PATH}`);
});

test("courseUrlFor (browser-safe) agrees with the kit", () => {
  assert.equal(courseUrlFor(`${APP}/`, "CRS-1", "/communities/courses/:code"), `${APP}/communities/courses/CRS-1`);
  assert.equal(courseUrlFor(APP, "CRS-1", null), `${APP}/communities/learning`);
  assert.equal(courseUrlFor(APP, "CRS-1", "//evil/:code"), `${APP}/communities/learning`);
});
