/**
 * Client mode's GET /session/me read (Iris on KIT-2, note 3): it gives up after
 * about 5 s and answers signed out, so the header shows "Log in" and is never
 * left empty; it asks again only on the next user action, never on a timer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionMeReader, SESSION_ME_TIMEOUT_MS } from "../src/session-me.ts";

const MEMBER = { member: { firstName: "Asha" }, signOutToken: "t".repeat(43) };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Reply = "hang" | "network" | { status: number; body?: unknown };
function fakeFetch(replies: Reply[]) {
  const calls: { signal: AbortSignal | null | undefined }[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ signal: init?.signal });
    const reply = replies[calls.length - 1] ?? replies[replies.length - 1]!;
    if (reply === "network") throw new TypeError("fetch failed");
    if (reply === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

test("the timeout is about 5 s", () => {
  assert.equal(SESSION_ME_TIMEOUT_MS, 5_000);
});

test("a hung read answers signed out after the timeout, and the request is aborted", async () => {
  const api = fakeFetch(["hang"]);
  const reader = createSessionMeReader({ fetch: api.fetch, timeoutMs: 20 });
  const started = Date.now();
  const result = await reader.read();
  assert.deepEqual(result, { member: null, signOutToken: null, retryable: true });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(api.calls[0]!.signal?.aborted, true);
});

test("no retry loop: after a timeout nothing is asked again until a user action", async () => {
  const api = fakeFetch(["hang", { status: 200, body: MEMBER }]);
  const reader = createSessionMeReader({ fetch: api.fetch, timeoutMs: 20 });
  await reader.read();
  await sleep(150);
  assert.equal(api.calls.length, 1);
});

test("the next user action retries once, and can turn the header into My account", async () => {
  const api = fakeFetch(["hang", { status: 200, body: MEMBER }]);
  const reader = createSessionMeReader({ fetch: api.fetch, timeoutMs: 20 });
  await reader.read();
  const retried = await reader.retry();
  assert.deepEqual(retried, { member: { firstName: "Asha" }, signOutToken: MEMBER.signOutToken, retryable: false });
  assert.equal(api.calls.length, 2);
  // Not retryable any more: a later action asks nothing.
  assert.equal(await reader.retry(), null);
  assert.equal(api.calls.length, 2);
});

test("actions during a read in flight share it; a second action never stacks a request", async () => {
  const api = fakeFetch(["hang", "hang", { status: 200, body: MEMBER }]);
  const reader = createSessionMeReader({ fetch: api.fetch, timeoutMs: 30 });
  await reader.read();
  const a = reader.retry();
  const b = reader.retry();
  await Promise.all([a, b]);
  assert.equal(api.calls.length, 2);
});

test("a network fault or a non-200 is signed out and retryable; a real signed-out answer is not", async () => {
  for (const reply of ["network", { status: 500 }, { status: 403 }] as Reply[]) {
    const result = await createSessionMeReader({ fetch: fakeFetch([reply]).fetch, timeoutMs: 20 }).read();
    assert.deepEqual(result, { member: null, signOutToken: null, retryable: true });
  }
  const signedOut = await createSessionMeReader({ fetch: fakeFetch([{ status: 200, body: { member: null, signOutToken: null } }]).fetch }).read();
  assert.deepEqual(signedOut, { member: null, signOutToken: null, retryable: false });
});
