/**
 * Member events (B2 + B4): the signed-in member's own view of one event and
 * their registration, from the site's server, against a fake API answering the
 * gateway's `events/read` and `events/register`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemberEvents, MEMBER_EVENT_READ_TIMEOUT_MS, MEMBER_EVENT_REGISTER_TIMEOUT_MS } from "../src/events.ts";
import { createWebsiteKit } from "../src/flows.ts";
import { API, APP, ORIGIN, SECRET, TOKEN } from "./helpers.ts";

const SLUG = "codeclick-test";
const EVENT_ID = "4f0c2a8e-1b3d-4e5f-9a7b-0c1d2e3f4a5b";
const SIGNED_IN = { "__Host-zw_session": TOKEN };
const FORM = {
  phone: "REQUIRED",
  questions: [
    {
      key: "company",
      type: "TEXT",
      label: "Company",
      required: true,
      helpText: null,
      placeholder: null,
      maxLength: 120,
      options: [],
      signUpField: null,
      viewerPrefill: { value: "Acme", display: "Acme" },
    },
    {
      key: "track",
      type: "SINGLE_CHOICE",
      label: "Track",
      required: false,
      helpText: "Pick one",
      placeholder: null,
      maxLength: null,
      options: [{ value: "a", label: "A", exclusive: false }],
      signUpField: null,
      viewerPrefill: null,
    },
  ],
  consents: [{ key: "terms", labelHtml: "I accept the <a href=\"/terms\">terms</a>", required: true, wordingVersion: "v1" }],
  sensitiveRetentionDays: null,
};
const EVENT = { id: EVENT_ID, viewerStatus: null, ended: false, form: FORM };

type Reply = { status: number; body?: unknown } | "timeout" | "network";
interface Call {
  call: "read" | "register";
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

function fakeEventsApi(replies: { read?: Reply[]; register?: Reply[] }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call = url.endsWith("/events/read") ? "read" : url.endsWith("/events/register") ? "register" : null;
    if (!call) throw new Error(`unexpected call ${url}`);
    calls.push({ call, url, authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    const reply = replies[call]?.[calls.filter((c) => c.call === call).length - 1];
    if (reply === undefined) throw new Error(`no reply configured for ${call}`);
    if (reply === "network") throw new TypeError(`fetch failed ${SECRET} ${TOKEN}`);
    if (reply === "timeout") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function setup(replies: { read?: Reply[]; register?: Reply[] }, options: Parameters<typeof createMemberEvents>[1] = {}) {
  const api = fakeEventsApi(replies);
  const kit = createWebsiteKit({ apiUrl: API, appUrl: APP, realm: "acme", clientSecret: SECRET, origin: ORIGIN, fetch: api.fetch });
  return { api, kit, events: createMemberEvents(kit, options) };
}

const ok = (body: unknown): Reply => ({ status: 200, body });

test("the timeouts: 10 s for a read, 15 s for a registration", () => {
  assert.equal(MEMBER_EVENT_READ_TIMEOUT_MS, 10_000);
  assert.equal(MEMBER_EVENT_REGISTER_TIMEOUT_MS, 15_000);
});

// ---------------------------------------------------------------------------
// getMemberEvent
// ---------------------------------------------------------------------------

test("getMemberEvent: POST events/read with the secret in the header only, realm/origin/sessionToken/slug in the body", async () => {
  const { api, events } = setup({ read: [ok({ status: "ok", event: EVENT })] });
  const result = await events.getMemberEvent(SIGNED_IN, SLUG);
  assert.deepEqual(result, { status: "ok", event: EVENT });
  assert.equal(api.calls.length, 1);
  const call = api.calls[0]!;
  assert.equal(call.url, `${API}/api/external/session-handover/events/read`);
  assert.equal(call.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(call.body, { realm: "acme", origin: ORIGIN, sessionToken: TOKEN, slug: SLUG });
  assert.ok(!JSON.stringify(call.body).includes(SECRET));
});

test("getMemberEvent: REGISTERED / WAITLISTED with no form, and an ended event", async () => {
  for (const viewerStatus of ["REGISTERED", "WAITLISTED"] as const) {
    const event = { id: EVENT_ID, viewerStatus, ended: false, form: null };
    assert.deepEqual(await setup({ read: [ok({ status: "ok", event })] }).events.getMemberEvent(SIGNED_IN, SLUG), { status: "ok", event });
  }
  const ended = { id: EVENT_ID, viewerStatus: null, ended: true, form: null };
  assert.deepEqual(await setup({ read: [ok({ status: "ok", event: ended })] }).events.getMemberEvent(SIGNED_IN, SLUG), { status: "ok", event: ended });
});

test("getMemberEvent: only the contract's fields are kept; unknown fields of the API are dropped", async () => {
  const noisy = {
    status: "ok",
    debug: "x",
    event: {
      ...EVENT,
      internalNote: "never shown",
      form: {
        ...FORM,
        builtInLabels: { name: null, email: null, phone: null },
        questions: FORM.questions.map((q) => ({ ...q, profileField: "company", sensitive: true })),
      },
    },
  };
  const result = await setup({ read: [ok(noisy)] }).events.getMemberEvent(SIGNED_IN, SLUG);
  assert.deepEqual(result, { status: "ok", event: EVENT });
});

test("getMemberEvent: no session cookie is signed-out and the API is never asked", async () => {
  const { api, events } = setup({});
  assert.deepEqual(await events.getMemberEvent({}, SLUG), { status: "signed-out" });
  assert.deepEqual(await events.getMemberEvent({ "__Host-zw_session": "not-a-token" }, SLUG), { status: "signed-out" });
  assert.equal(api.calls.length, 0);
});

test("getMemberEvent: a malformed slug is invalid-request and the API is never asked", async () => {
  const { api, events } = setup({});
  for (const slug of ["", "Has-Caps", "a/b", "../x", "-a", "a-", "a".repeat(201)]) {
    assert.deepEqual(await events.getMemberEvent(SIGNED_IN, slug), { status: "invalid-request" }, slug);
  }
  assert.equal(api.calls.length, 0);
});

test("getMemberEvent: ended (body or login_required) forgets the session; the caller clears the cookie", async () => {
  for (const reply of [ok({ status: "ended" }), { status: 403, body: { error: "login_required" } }]) {
    const { kit, events } = setup({ read: [reply] });
    let forgotten: string | null = null;
    const forget = kit.forget;
    kit.forget = async (token: string) => {
      forgotten = token;
      return forget(token);
    };
    assert.deepEqual(await events.getMemberEvent(SIGNED_IN, SLUG), { status: "ended" });
    assert.equal(forgotten, TOKEN);
  }
});

test("getMemberEvent: refused NOT_FOUND / NO_MEMBER_ROLE, from a 200 or an error status", async () => {
  for (const reason of ["NOT_FOUND", "NO_MEMBER_ROLE"]) {
    for (const status of [200, 403, 404]) {
      assert.deepEqual(
        await setup({ read: [{ status, body: { status: "refused", reason } }] }).events.getMemberEvent(SIGNED_IN, SLUG),
        { status: "refused", reason },
        `${reason} ${status}`
      );
    }
  }
});

test("getMemberEvent: a refusal code of the wrong shape is not passed on", async () => {
  const result = await setup({ read: [ok({ status: "refused", reason: "<script>" })] }).events.getMemberEvent(SIGNED_IN, SLUG);
  assert.deepEqual(result, { status: "refused" });
});

test("getMemberEvent: a 404 with no contract body is not-available (an API without member events)", async () => {
  assert.deepEqual(await setup({ read: [{ status: 404 }] }).events.getMemberEvent(SIGNED_IN, SLUG), { status: "not-available" });
});

test("getMemberEvent: unavailable for the body, a 503, a 429, a 401, a timeout, a network fault and a malformed answer", async () => {
  const replies: Reply[] = [
    ok({ status: "unavailable" }),
    { status: 503, body: { error: "unavailable" } },
    { status: 429, body: { error: "rate_limited" } },
    { status: 401, body: { error: "invalid_client" } },
    "timeout",
    "network",
    ok({ status: "ok" }),
    ok({ status: "ok", event: { ...EVENT, id: 7 } }),
    ok({ status: "ok", event: { ...EVENT, viewerStatus: "CANCELLED" } }),
    ok({ status: "ok", event: { ...EVENT, ended: "no" } }),
    ok({ status: "ok", event: { ...EVENT, form: { ...FORM, phone: "MAYBE" } } }),
    ok({ status: "ok", event: { ...EVENT, form: { ...FORM, questions: [{ ...FORM.questions[0], viewerPrefill: "Acme" }] } } }),
    ok({ status: "ok", event: { ...EVENT, form: { ...FORM, consents: [{ key: "terms" }] } } }),
    ok({ status: "what" }),
    ok(null),
  ];
  for (const reply of replies) {
    const { api, events } = setup({ read: [reply] }, { readTimeoutMs: 20 });
    assert.deepEqual(await events.getMemberEvent(SIGNED_IN, SLUG), { status: "unavailable" }, JSON.stringify(reply));
    assert.equal(api.calls.length, 1, "never retried");
  }
});

// ---------------------------------------------------------------------------
// registerMemberEvent
// ---------------------------------------------------------------------------

const REGISTRATION = {
  answers: [
    { key: "track", value: "a" },
    { key: "topics", value: ["x", "y"] },
    { key: "newsletter", value: true },
  ],
  consents: [{ key: "terms", accepted: true, wordingVersion: "v1" }],
  phone: "+1 555 0100",
};

test("registerMemberEvent: POST events/register with the slug, answers, consents and phone; ok answers the seat", async () => {
  const { api, events } = setup({ register: [ok({ status: "ok", seat: "REGISTERED" })] });
  assert.deepEqual(await events.registerMemberEvent(SIGNED_IN, SLUG, REGISTRATION), { status: "ok", seat: "REGISTERED" });
  const call = api.calls[0]!;
  assert.equal(call.url, `${API}/api/external/session-handover/events/register`);
  assert.equal(call.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(call.body, { realm: "acme", origin: ORIGIN, sessionToken: TOKEN, slug: SLUG, ...REGISTRATION });
});

test("registerMemberEvent: nothing to ask sends no answers, consents or phone", async () => {
  const { api, events } = setup({ register: [ok({ status: "ok", seat: "WAITLISTED" })] });
  assert.deepEqual(await events.registerMemberEvent(SIGNED_IN, SLUG), { status: "ok", seat: "WAITLISTED" });
  assert.deepEqual(api.calls[0]!.body, { realm: "acme", origin: ORIGIN, sessionToken: TOKEN, slug: SLUG });
});

test("registerMemberEvent: only the contract's fields go on; extra fields from the page are dropped", async () => {
  const { api, events } = setup({ register: [ok({ status: "ok", seat: "REGISTERED" })] });
  const page = {
    answers: [{ key: "track", value: "a", label: "Track" }],
    consents: [{ key: "terms", accepted: true, wordingVersion: "v1", labelHtml: "x" }],
    realm: "other",
    origin: "https://evil.example",
    sessionToken: "f".repeat(64),
    email: "someone@example.org",
  } as unknown as Parameters<typeof events.registerMemberEvent>[2];
  await events.registerMemberEvent(SIGNED_IN, SLUG, page);
  assert.deepEqual(api.calls[0]!.body, {
    realm: "acme",
    origin: ORIGIN,
    sessionToken: TOKEN,
    slug: SLUG,
    answers: [{ key: "track", value: "a" }],
    consents: [{ key: "terms", accepted: true, wordingVersion: "v1" }],
  });
});

test("registerMemberEvent: a malformed registration is invalid-request and the API is never asked", async () => {
  const { api, events } = setup({});
  const bad: unknown[] = [
    { answers: "x" },
    { answers: [{ key: "1bad", value: "a" }] },
    { answers: [{ key: "ok", value: 3 }] },
    { answers: [{ key: "ok", value: ["a", 1] }] },
    { answers: Array.from({ length: 61 }, (_v, i) => ({ key: `q${i}`, value: "a" })) },
    { consents: [{ key: "terms", accepted: "yes", wordingVersion: "v1" }] },
    { consents: [{ key: "terms", accepted: true, wordingVersion: "" }] },
    { consents: Array.from({ length: 13 }, (_v, i) => ({ key: `c${i}`, accepted: true, wordingVersion: "v1" })) },
    { phone: "call me" },
    { phone: 5550100 },
    "not an object",
  ];
  for (const registration of bad) {
    assert.deepEqual(
      await events.registerMemberEvent(SIGNED_IN, SLUG, registration as Parameters<typeof events.registerMemberEvent>[2]),
      { status: "invalid-request" },
      JSON.stringify(registration)
    );
  }
  assert.deepEqual(await events.registerMemberEvent(SIGNED_IN, "Bad Slug"), { status: "invalid-request" });
  assert.equal(api.calls.length, 0);
});

test("registerMemberEvent: no session cookie is signed-out and the API is never asked", async () => {
  const { api, events } = setup({});
  assert.deepEqual(await events.registerMemberEvent({}, SLUG, REGISTRATION), { status: "signed-out" });
  assert.equal(api.calls.length, 0);
});

test("registerMemberEvent: ended forgets the session", async () => {
  for (const reply of [ok({ status: "ended" }), { status: 403, body: { error: "login_required" } }]) {
    assert.deepEqual(await setup({ register: [reply] }).events.registerMemberEvent(SIGNED_IN, SLUG), { status: "ended" });
  }
});

test("registerMemberEvent: refused carries the reason and the fields it names", async () => {
  for (const status of [200, 409, 422]) {
    const reply = { status, body: { status: "refused", reason: "ANSWER_INVALID", fields: ["track", "company"] } };
    assert.deepEqual(await setup({ register: [reply] }).events.registerMemberEvent(SIGNED_IN, SLUG, REGISTRATION), {
      status: "refused",
      reason: "ANSWER_INVALID",
      fields: ["track", "company"],
    });
  }
  for (const reason of ["ALREADY_REGISTERED", "CONSENT_REQUIRED", "FORM_CHANGED", "CLOSED", "NOT_FOUND", "NO_MEMBER_ROLE"]) {
    assert.deepEqual(await setup({ register: [ok({ status: "refused", reason })] }).events.registerMemberEvent(SIGNED_IN, SLUG), {
      status: "refused",
      reason,
    });
  }
});

test("registerMemberEvent: field keys and reasons of the wrong shape are not passed on", async () => {
  const reply = ok({ status: "refused", reason: "bad reason", fields: ["track", "<b>", 3, "a".repeat(41)] });
  assert.deepEqual(await setup({ register: [reply] }).events.registerMemberEvent(SIGNED_IN, SLUG), { status: "refused", fields: ["track"] });
  const none = ok({ status: "refused", reason: "CLOSED", fields: "track" });
  assert.deepEqual(await setup({ register: [none] }).events.registerMemberEvent(SIGNED_IN, SLUG), { status: "refused", reason: "CLOSED" });
});

test("registerMemberEvent: unavailable for the body, a 503, a 429, a timeout, a network fault or a malformed seat, and NEVER retried", async () => {
  const replies: Reply[] = [
    ok({ status: "unavailable" }),
    { status: 503, body: { error: "unavailable" } },
    { status: 429, body: { error: "rate_limited" } },
    "timeout",
    "network",
    ok({ status: "ok" }),
    ok({ status: "ok", seat: "CANCELLED" }),
  ];
  for (const reply of replies) {
    const { api, events } = setup({ register: [reply] }, { registerTimeoutMs: 20 });
    assert.deepEqual(await events.registerMemberEvent(SIGNED_IN, SLUG, REGISTRATION), { status: "unavailable" }, JSON.stringify(reply));
    assert.equal(api.calls.length, 1, "never retried");
  }
  assert.deepEqual(await setup({ register: [{ status: 404 }] }).events.registerMemberEvent(SIGNED_IN, SLUG), { status: "not-available" });
});

test("nothing thrown or answered carries a secret, a token or an answer: a failing fetch is answered, never rethrown", async () => {
  const { events } = setup({ read: ["network"], register: ["network"] });
  const read = await events.getMemberEvent(SIGNED_IN, SLUG);
  const registered = await events.registerMemberEvent(SIGNED_IN, SLUG, REGISTRATION);
  for (const answer of [read, registered]) {
    const text = JSON.stringify(answer);
    assert.ok(!text.includes(SECRET) && !text.includes(TOKEN) && !text.includes("555"));
  }
});
