/** The code step's headless state and copy (spec §6; plan K3). */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CODE_STEP_COPY, codeStepError, codeStepReducer, initialCodeStep, resendCountdown, type CodeStepState } from "../src/code-step.ts";

const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const TICKET = { codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: "2026-10-28T10:01:00.000Z" };

function onCode(): CodeStepState {
  let s = codeStepReducer(initialCodeStep(), { type: "send", email: "buyer@example.org" });
  s = codeStepReducer(s, { type: "sent", ticket: TICKET, now: NOW });
  return s;
}

test("CODE_STEP_COPY is the spec's copy, word for word", () => {
  assert.deepEqual({ ...CODE_STEP_COPY }, {
    heading: "Check your email",
    intro: "We sent a 6-digit code to {email}. Enter it to continue to payment.",
    codeLabel: "Code",
    verifyButton: "Continue",
    resendWaiting: "Send a new code in {seconds}s",
    resendReady: "Send a new code",
    changeEmail: "Use a different email",
    wrongCode: "That code isn't right. Check it and try again, or send a new code.",
    expiredCode: "That code has expired. Send a new code to continue.",
    locked: "Too many tries. Try again in {minutes} min.",
    otherError: "We couldn't check your code. Try again.",
    resendCap: "You've asked for the most codes we can send for now. Try again in {minutes} min, or use a different email.",
    hint: "Didn't get a code? Check your spam folder, or use a different email.",
    terms: "By continuing you agree to the {terms link}.",
    accountReady: "Your account is ready.",
  });
  assert.ok(Object.isFrozen(CODE_STEP_COPY));
});

test("email → sending → code, focus moves to the code input", () => {
  const s = onCode();
  assert.equal(s.step, "code");
  assert.equal(s.email, "buyer@example.org");
  assert.equal(s.focusCode, 1);
  assert.equal(s.codeExpiresAt, NOW + 600_000);
});

test("double-submit guard: a second send or verify in flight is ignored; Continue is off while verifying", () => {
  const sending = codeStepReducer(initialCodeStep(), { type: "send", email: "a@b.co" });
  assert.equal(codeStepReducer(sending, { type: "send", email: "c@d.co" }), sending);
  const verifying = codeStepReducer(onCode(), { type: "verify" });
  assert.equal(verifying.step, "verifying");
  assert.equal(codeStepReducer(verifying, { type: "verify" }), verifying);
  assert.equal(codeStepReducer(verifying, { type: "resend" }), verifying);
  const resending = codeStepReducer(onCode(), { type: "resend" });
  assert.equal(codeStepReducer(resending, { type: "verify" }), resending);
});

test("each reason's message, and focus only for invalid or expired", () => {
  const cases: [string, number | undefined, string, boolean][] = [
    ["WEBSITE_CODE_INVALID", undefined, CODE_STEP_COPY.wrongCode, true],
    ["WEBSITE_CODE_EXPIRED", undefined, CODE_STEP_COPY.expiredCode, true],
    ["WEBSITE_CODE_LOCKED", 600, "Too many tries. Try again in 10 min.", false],
    ["WEBSITE_CODE_RATE_LIMITED", 61, "Too many tries. Try again in 2 min.", false],
    ["WEBSITE_CODE_RATE_LIMITED", 5, "Too many tries. Try again in 1 min.", false],
    ["UNAVAILABLE", undefined, CODE_STEP_COPY.otherError, false],
    ["SOMETHING_NEW", undefined, CODE_STEP_COPY.otherError, false],
  ];
  for (const [reason, retryAfterSeconds, message, focus] of cases) {
    const before = codeStepReducer(onCode(), { type: "verify" });
    const after = codeStepReducer(before, { type: "failed", refusal: { reason, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) } });
    assert.equal(after.step, "code", reason);
    assert.equal(after.error?.message, message, reason);
    assert.equal(after.focusCode, focus ? before.focusCode + 1 : before.focusCode, reason);
  }
});

test("a failed send goes back to the email step with the reason", () => {
  const sending = codeStepReducer(initialCodeStep(), { type: "send", email: "a@b.co" });
  const s = codeStepReducer(sending, { type: "failed", refusal: { reason: "BOT_CHECK_FAILED" } });
  assert.equal(s.step, "email");
  assert.equal(s.error?.reason, "BOT_CHECK_FAILED");
  assert.equal(s.error?.message, CODE_STEP_COPY.otherError);
});

test("verified keeps only the display notice", () => {
  const s = codeStepReducer(codeStepReducer(onCode(), { type: "verify" }), {
    type: "verified",
    answer: { member: { firstName: "Asha" }, notice: "account-ready", signOutToken: "c".repeat(43) },
  });
  assert.equal(s.step, "verified");
  assert.equal(s.notice, "account-ready");
  assert.ok(!("isNewAccount" in s));
});

test("countdown text: Send a new code in {s}s, then Send a new code", () => {
  const s = onCode();
  assert.deepEqual(resendCountdown(s, NOW), { seconds: 60, label: "Send a new code in 60s", canResend: false });
  assert.deepEqual(resendCountdown(s, NOW + 59_500), { seconds: 1, label: "Send a new code in 1s", canResend: false });
  assert.deepEqual(resendCountdown(s, NOW + 60_000), { seconds: 0, label: "Send a new code", canResend: true });
});

test("Use a different email: back to the email step, keeping the address to edit", () => {
  const s = codeStepReducer(onCode(), { type: "changeEmail" });
  assert.equal(s.step, "email");
  assert.equal(s.email, "buyer@example.org");
  assert.equal(s.resendAvailableAt, null);
});

test("restore opens the code step from the ticket cookie's read", () => {
  const s = codeStepReducer(initialCodeStep(), {
    type: "restore",
    pending: { email: "buyer@example.org", codeLength: 6, codeExpiresAt: "2026-10-28T10:10:00.000Z", resendAvailableAt: TICKET.resendAvailableAt },
  });
  assert.equal(s.step, "code");
  assert.equal(s.focusCode, 1);
});

test("codeStepError keeps the fields", () => {
  assert.deepEqual(codeStepError({ reason: "WEBSITE_TERMS_REQUIRED", fields: ["acceptedDocuments"] }).fields, ["acceptedDocuments"]);
});
