/** The code step's headless state and copy (spec v3.2 §8, §8a, A2). */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CODE_STEP_COPY,
  codeStepAnnouncement,
  codeStepError,
  codeStepReducer,
  formatAmount,
  initialCodeStep,
  normalizeCode,
  resendCountdown,
  type CodeStepState,
} from "../src/code-step.ts";

const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const TICKET = { codeLength: 6, codeExpiresInSeconds: 600, resendAvailableAt: "2026-10-28T10:01:00.000Z" };

function onCode(init: Parameters<typeof initialCodeStep>[0] = ""): CodeStepState {
  let s = codeStepReducer(initialCodeStep(init), { type: "send", email: "buyer@example.org" });
  s = codeStepReducer(s, { type: "sent", ticket: TICKET, now: NOW });
  return s;
}

test("CODE_STEP_COPY is the §8a copy, word for word", () => {
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
    resendCap: "You've asked for the most codes we can send for now. Try again in {minutes} min, or use a different email.",
    otherError: "We couldn't check your code. Try again.",
    hint: "Didn't get a code? Check your spam folder, or use a different email.",
    invalidEmail: "Enter a valid email address.",
    terms: "I agree to the {terms links}.",
    goingToPayment: "Taking you to payment…",
    memberPrice: "Your member price is {amount}.",
    payButton: "Pay {amount}",
    continueSignUp: "Continue sign-up",
    goToCourse: "Go to my course",
  });
  assert.ok(Object.isFrozen(CODE_STEP_COPY));
});

test("email → sending → code, focus moves to the code input", () => {
  const s = onCode();
  assert.equal(s.step, "code");
  assert.equal(s.email, "buyer@example.org");
  assert.equal(s.focusCode, 1);
  assert.equal(s.codeExpiresAt, NOW + 600_000);
  assert.equal(s.countdownFrom, 60);
});

test("double-submit guard: a second send, verify or pay in flight is ignored", () => {
  const sending = codeStepReducer(initialCodeStep(), { type: "send", email: "a@b.co" });
  assert.equal(codeStepReducer(sending, { type: "send", email: "c@d.co" }), sending);
  const verifying = codeStepReducer(onCode(), { type: "verify" });
  assert.equal(verifying.step, "verifying");
  assert.equal(codeStepReducer(verifying, { type: "verify" }), verifying);
  assert.equal(codeStepReducer(verifying, { type: "resend" }), verifying);
  const resending = codeStepReducer(onCode(), { type: "resend" });
  assert.equal(codeStepReducer(resending, { type: "verify" }), resending);
  const paying = { ...onCode(), step: "paying" as const };
  assert.equal(codeStepReducer(paying, { type: "pay" }), paying);
});

test("each reason's message, the input it belongs to, and focus only for invalid or expired", () => {
  const cases: [string, number | undefined, string, string, boolean][] = [
    ["WEBSITE_CODE_INVALID", undefined, CODE_STEP_COPY.wrongCode, "code", true],
    ["WEBSITE_CODE_EXPIRED", undefined, CODE_STEP_COPY.expiredCode, "code", true],
    ["WEBSITE_CODE_LOCKED", 600, "Too many tries. Try again in 10 min.", "code", false],
    ["WEBSITE_CODE_RATE_LIMITED", 61, "Too many tries. Try again in 2 min.", "code", false],
    ["WEBSITE_CODE_RATE_LIMITED", 5, "Too many tries. Try again in 1 min.", "code", false],
    ["UNAVAILABLE", undefined, CODE_STEP_COPY.otherError, "code", false],
    ["SOMETHING_NEW", undefined, CODE_STEP_COPY.otherError, "code", false],
  ];
  for (const [reason, retryAfterSeconds, message, field, focus] of cases) {
    const before = codeStepReducer(onCode(), { type: "verify" });
    const after = codeStepReducer(before, { type: "failed", refusal: { reason, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) } });
    assert.equal(after.step, "code", reason);
    assert.equal(after.error?.message, message, reason);
    assert.equal(after.error?.field, field, reason);
    assert.equal(after.focusCode, focus ? before.focusCode + 1 : before.focusCode, reason);
  }
});

test("E5: WEBSITE_CODE_LOCKED answering a resend is the resend cap line, and holds Send a new code for the wait", () => {
  const resending = codeStepReducer(onCode(), { type: "resend" });
  const s = codeStepReducer(resending, { type: "failed", refusal: { reason: "WEBSITE_CODE_LOCKED", retryAfterSeconds: 900 }, now: NOW + 61_000 });
  assert.equal(s.step, "code");
  assert.equal(s.error?.message, "You've asked for the most codes we can send for now. Try again in 15 min, or use a different email.");
  assert.equal(resendCountdown(s, NOW + 61_000).canResend, false);
  assert.equal(resendCountdown(s, NOW + 61_000 + 900_000).canResend, true);
});

test("an invalid email at start is 'Enter a valid email address.' on the email input", () => {
  const sending = codeStepReducer(initialCodeStep(), { type: "send", email: "nope" });
  const s = codeStepReducer(sending, { type: "failed", refusal: { reason: "WEBSITE_CODE_EMAIL_INVALID" } });
  assert.equal(s.step, "email");
  assert.equal(s.error?.message, "Enter a valid email address.");
  assert.equal(s.error?.field, "email");
});

test("a failed send goes back to the email step with the reason, tied to the email input", () => {
  const sending = codeStepReducer(initialCodeStep(), { type: "send", email: "a@b.co" });
  const s = codeStepReducer(sending, { type: "failed", refusal: { reason: "BOT_CHECK_FAILED" } });
  assert.equal(s.step, "email");
  assert.equal(s.error?.reason, "BOT_CHECK_FAILED");
  assert.equal(s.error?.message, CODE_STEP_COPY.otherError);
  assert.equal(s.error?.field, "email");
});

test("terms required is recoverable: the step stays, the tick box shows and gets focus, ticking clears the error", () => {
  const verifying = codeStepReducer(onCode(), { type: "verify" });
  const s = codeStepReducer(verifying, { type: "failed", refusal: { reason: "WEBSITE_TERMS_REQUIRED", fields: ["acceptedDocuments"] } });
  assert.equal(s.step, "code");
  assert.equal(s.termsRequired, true);
  assert.equal(s.error?.field, "terms");
  assert.equal(s.focusTerms, verifying.focusTerms + 1);
  const ticked = codeStepReducer(s, { type: "terms", accepted: true });
  assert.equal(ticked.termsAccepted, true);
  assert.equal(ticked.error, null);
  // and Continue works again
  assert.equal(codeStepReducer(ticked, { type: "verify" }).step, "verifying");
});

test("after verify: redirect → paying; a changed total → confirm-price; Pay → paying", () => {
  const verifying = codeStepReducer(onCode(), { type: "verify" });
  const going = codeStepReducer(verifying, { type: "answered", answer: { kind: "redirect", url: "https://pay.example/x", orderId: "o", orderToken: "t", orderTokenExpiresAt: null, settled: false } });
  assert.equal(going.step, "paying");
  const confirm = codeStepReducer(verifying, { type: "answered", answer: { kind: "confirm-price", totalMinor: "7900", currencyCode: "USD", minorUnitExponent: 2 } });
  assert.equal(confirm.step, "confirm-price");
  assert.deepEqual(confirm.price, { totalMinor: "7900", currencyCode: "USD", minorUnitExponent: 2 });
  assert.equal(codeStepReducer(confirm, { type: "pay" }).step, "paying");
  const owned = codeStepReducer(verifying, { type: "answered", answer: { kind: "already-owned" } });
  assert.equal(owned.step, "owned");
});

test("a proof the API no longer accepts sends the buyer back to the email step with the email kept", () => {
  const paying = codeStepReducer({ ...onCode(), step: "confirm-price" }, { type: "pay" });
  const s = codeStepReducer(paying, { type: "answered", answer: { kind: "payment-failed", reason: "CHECKOUT_PROOF_INVALID" } });
  assert.equal(s.step, "email");
  assert.equal(s.email, "buyer@example.org");
  const other = codeStepReducer(paying, { type: "answered", answer: { kind: "payment-failed", reason: "UNAVAILABLE" } });
  assert.equal(other.step, "pay-failed");
  assert.equal(other.error?.message, CODE_STEP_COPY.otherError);
  assert.equal(codeStepReducer(other, { type: "pay" }).step, "paying");
});

test("countdown text: Send a new code in {s}s, then Send a new code", () => {
  const s = onCode();
  assert.deepEqual(resendCountdown(s, NOW), { seconds: 60, label: "Send a new code in 60s", canResend: false });
  assert.deepEqual(resendCountdown(s, NOW + 59_500), { seconds: 1, label: "Send a new code in 1s", canResend: false });
  assert.deepEqual(resendCountdown(s, NOW + 60_000), { seconds: 0, label: "Send a new code", canResend: true });
});

test("the polite announcement changes only at start and when ready, never every second", () => {
  const s = onCode();
  assert.equal(codeStepAnnouncement(s, NOW), "Send a new code in 60s");
  assert.equal(codeStepAnnouncement(s, NOW + 30_000), "Send a new code in 60s");
  assert.equal(codeStepAnnouncement(s, NOW + 59_000), "Send a new code in 60s");
  assert.equal(codeStepAnnouncement(s, NOW + 60_000), "Send a new code");
  assert.equal(codeStepAnnouncement({ ...s, step: "paying" }, NOW), "Taking you to payment…");
  assert.equal(codeStepAnnouncement(initialCodeStep(), NOW), "");
});

test("paste of '123 456' (and any non-digits) is stripped, then sliced to the code length", () => {
  assert.equal(normalizeCode("123 456"), "123456");
  assert.equal(normalizeCode(" 12-34 56 78"), "123456");
  assert.equal(normalizeCode("12 34", 6), "1234");
  assert.equal(normalizeCode("Your code: 987 654.", 6), "987654");
});

test("formatAmount: minor units as money", () => {
  assert.equal(formatAmount({ totalMinor: "7900", minorUnitExponent: 2, currencyCode: "USD" }), "$79.00");
  assert.equal(formatAmount({ totalMinor: "1500", minorUnitExponent: 0, currencyCode: "JPY" }), "¥1,500");
});

test("Use a different email: back to the email step, keeping the address to edit", () => {
  const s = codeStepReducer(onCode({ termsRequired: true }), { type: "changeEmail" });
  assert.equal(s.step, "email");
  assert.equal(s.email, "buyer@example.org");
  assert.equal(s.resendAvailableAt, null);
  assert.equal(s.termsRequired, true);
});

test("restore opens the code step from the ticket cookie's read", () => {
  const s = codeStepReducer(initialCodeStep(), {
    type: "restore",
    pending: { email: "buyer@example.org", codeLength: 6, codeExpiresAt: "2026-10-28T10:10:00.000Z", resendAvailableAt: TICKET.resendAvailableAt },
    now: NOW + 20_000,
  });
  assert.equal(s.step, "code");
  assert.equal(s.focusCode, 1);
  assert.equal(s.countdownFrom, 40);
});

test("codeStepError keeps the fields", () => {
  assert.deepEqual(codeStepError({ reason: "WEBSITE_TERMS_REQUIRED", fields: ["acceptedDocuments"] }).fields, ["acceptedDocuments"]);
});

test("every PROOF_GONE reason after verify or pay sends the step back to the email step, the email kept", async () => {
  const { PROOF_GONE_REASONS, codeStepReducer: reduce, initialCodeStep: init } = await import("../src/code-step.ts");
  for (const reason of PROOF_GONE_REASONS) {
    for (const step of ["verifying", "paying"] as const) {
      const s = reduce({ ...init({ email: "buyer@example.org" }), step }, { type: "answered", answer: { kind: "payment-failed", reason } });
      assert.equal(s.step, "email", `${reason} while ${step}`);
      assert.equal(s.email, "buyer@example.org");
      assert.equal(s.error?.reason, reason);
    }
  }
});
