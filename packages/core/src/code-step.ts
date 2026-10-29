/**
 * The code step's copy and its headless state (checkout v3.2, spec §8, §8a,
 * §10b A2): the page draws the step, this decides what it says and when.
 * Framework-free, so `useCodeStep` (Next) and any other site use the same rules.
 *
 *   email ─send─► sending ─sent─► code ─verify─► verifying ─┬─ redirect ──────► paying (to the provider)
 *     ▲              │              │ ▲              │       ├─ confirm-price ─► confirm-price ─pay─► paying
 *     └──failed──────┘              │ └──failed──────┘       ├─ already-owned ─► owned
 *     └──────── changeEmail ────────┘                        └─ payment-failed ► pay-failed ─pay─► paying
 *
 * Also: a payment-failed whose reason means the proof is gone returns to email (the email kept); a failed pay
 * goes to pay-failed; changeEmail also leaves pay-failed and confirm-price.
 *
 * The code step creates no account and no session: a right code gives the
 * site's SERVER a verified-email proof (HttpOnly cookie), and the same request
 * re-quotes with it. An unchanged total goes straight to payment; a changed
 * one (member price, D7) waits for "Pay {amount}" (A2).
 *
 * Errors are keyed by `reason` and name the input they belong to (`field`):
 * invalid or expired code (stay, focus the code input), locked or
 * rate-limited (the wait), the resend cap (E5, its own line and the wait),
 * terms required (the tick box, recoverable), an invalid email (the email
 * input), anything else the generic line. The reducer ignores a send, resend,
 * verify or pay that its step does not allow. The one-call-at-a-time guard is
 * the caller's own (useCodeStep's inFlight ref), since two clicks before a
 * re-render both see the old state.
 */

import type { CodeReason } from "./api-client.ts";

/** The kit's own reasons (never from the API): a purchase it refused, no answer, an order token it could not keep. */
export const KIT_REASONS = Object.freeze(["INVALID_REQUEST", "UNAVAILABLE", "STORAGE_UNAVAILABLE"] as const);
export type KitReason = (typeof KIT_REASONS)[number];

/**
 * A refusal reason the step can show: the API's (`CodeReason`, and the checkout start's own), the kit's, or one a
 * newer API adds (`string & {}` keeps it open while literals still autocomplete).
 */
export type CodeStepReason = CodeReason | KitReason | "PRICE_CHANGED" | "ALREADY_ENROLLED" | "HOSTED_GUEST_INVALID" | (string & {});

/** The step's copy, exactly as signed (spec §8a). A site may restyle it, never reword it. */
export const CODE_STEP_COPY = Object.freeze({
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
  /** `{terms links}` is where the site draws its links to the workspace's legal documents. */
  terms: "I agree to the {terms links}.",
  goingToPayment: "Taking you to payment…",
  /** A2: the re-quote after verify changed the total (member price). */
  memberPrice: "Your member price is {amount}.",
  payButton: "Pay {amount}",
  continueSignUp: "Continue sign-up",
  goToCourse: "Go to my course",
});

export type CodeStepCopyKey = keyof typeof CODE_STEP_COPY;

/** A copy line with its `{name}` placeholders filled. */
export function fillCopy(line: string, values: Record<string, string | number>): string {
  return line.replace(/\{([a-z ]+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

export type CodeStepName = "email" | "sending" | "code" | "verifying" | "confirm-price" | "paying" | "owned" | "pay-failed";

/** The input an error belongs to: the page ties the message to it (`aria-describedby`, `aria-invalid`). */
export type CodeStepField = "email" | "code" | "terms" | "payment";

export interface CodeStepError {
  /** The API's reason (`WEBSITE_CODE_INVALID`, ...), or `UNAVAILABLE` when it could not answer. */
  reason: CodeStepReason;
  /** The line to show (spec §8a). For `terms` it is the tick box's own line: show the tick box. */
  message: string;
  field: CodeStepField;
  retryAfterSeconds: number | null;
  /** `WEBSITE_TERMS_REQUIRED`: the fields the workspace needs. */
  fields?: string[];
}

/** A2: the new total after the re-quote with the proof. */
export interface CodeStepPrice {
  totalMinor: string;
  currencyCode: string;
  minorUnitExponent: number;
}

export interface CodeStepState {
  step: CodeStepName;
  email: string;
  codeLength: number;
  /** When the code stops working (ms), or null. */
  codeExpiresAt: number | null;
  /** When "Send a new code" is ready (ms), or null. */
  resendAvailableAt: number | null;
  /** The countdown's length when it started (seconds): what the polite live region says once. */
  countdownFrom: number;
  /** True while a resend is in flight (the step stays `code`). */
  resending: boolean;
  error: CodeStepError | null;
  /** Bumped whenever focus should go to the code input (the step opened; an invalid or expired code). */
  focusCode: number;
  /** Bumped whenever focus should go to the terms tick box (terms required). */
  focusTerms: number;
  /** The workspace requires terms: the tick box shows (also after a `WEBSITE_TERMS_REQUIRED`). */
  termsRequired: boolean;
  termsAccepted: boolean;
  /** `confirm-price`: the member price to show and pay (A2). */
  price: CodeStepPrice | null;
  /** `owned`: true when this start's order settled at once (a zero total). */
  settled: boolean;
}

/** What the kit's /session/code-start and /session/code-resend answer the browser. */
export interface CodeStepTicket {
  codeLength: number;
  codeExpiresInSeconds: number;
  resendAvailableAt: string;
}

/**
 * What /session/code-verify and /session/code-pay answer the browser (200).
 * Never the proof, never anything about membership beyond the price itself.
 */
export type CodeStepPayment =
  | {
      kind: "redirect";
      /** The payment page, or the site's return page when nothing was owed. */
      url: string;
      orderId: string;
      /** For the return page: keep it in sessionStorage, never in an address. */
      orderToken: string | null;
      orderTokenExpiresAt: string | null;
      settled: boolean;
    }
  | ({ kind: "confirm-price" } & CodeStepPrice)
  | { kind: "already-owned"; settled?: true }
  /** The code was right (or the proof is held), but payment could not start. */
  | { kind: "payment-failed"; reason: CodeStepReason };

/** A refusal as the kit's code routes answer it to the browser. */
export interface CodeStepRefusal {
  reason: CodeStepReason;
  retryAfterSeconds?: number;
  fields?: string[];
}

/** An open code step the kit's ticket cookie holds (GET /session/code-step), for a reload. */
export interface PendingCodeStep {
  email: string;
  codeLength: number;
  codeExpiresAt: string;
  resendAvailableAt: string;
}

export type CodeStepAction =
  | { type: "send"; email: string }
  | { type: "sent"; email?: string; ticket: CodeStepTicket; now: number }
  | { type: "resend" }
  | { type: "verify" }
  | { type: "pay" }
  | { type: "answered"; answer: CodeStepPayment }
  /** `now` is required: a resend refusal holds "Send a new code" for its wait from it (E5). */
  | { type: "failed"; refusal: CodeStepRefusal; now: number }
  | { type: "terms"; accepted: boolean }
  | { type: "changeEmail" }
  | { type: "restore"; pending: PendingCodeStep; now: number };

export const UNAVAILABLE_REASON = "UNAVAILABLE" satisfies KitReason;

/** Reasons after which the proof is gone: the buyer verifies again from the email step. The kit's server drops the proof cookie on the same list. */
export const PROOF_GONE_REASONS: readonly CodeReason[] = Object.freeze<CodeReason[]>([
  "CHECKOUT_PROOF_INVALID",
  "CHECKOUT_PROOF_EMAIL_MISMATCH",
  "EMAIL_VERIFICATION_REQUIRED",
]);

export const initialCodeStep = (init: string | { email?: string; termsRequired?: boolean } = ""): CodeStepState => {
  const o = typeof init === "string" ? { email: init } : init;
  return {
    step: "email",
    email: o.email ?? "",
    codeLength: 6,
    codeExpiresAt: null,
    resendAvailableAt: null,
    countdownFrom: 0,
    resending: false,
    error: null,
    focusCode: 0,
    focusTerms: 0,
    termsRequired: o.termsRequired === true,
    termsAccepted: false,
    price: null,
    settled: false,
  };
};

const minutesOf = (seconds: number | null): number => Math.max(1, Math.ceil((seconds ?? 60) / 60));

/**
 * The line for a refusal, by reason (the same reason always says the same
 * thing). `during` says what was asked: a `WEBSITE_CODE_LOCKED` answering a
 * resend is the resend cap (E5, §4.2).
 */
export function codeStepError(refusal: CodeStepRefusal, during: "start" | "resend" | "verify" | "pay" = "verify"): CodeStepError {
  const retry = typeof refusal.retryAfterSeconds === "number" ? refusal.retryAfterSeconds : null;
  const base = { reason: refusal.reason, retryAfterSeconds: retry, ...(refusal.fields ? { fields: refusal.fields } : {}) };
  const field: CodeStepField = during === "start" ? "email" : during === "pay" ? "payment" : "code";
  switch (refusal.reason) {
    case "WEBSITE_CODE_EMAIL_INVALID":
      return { ...base, field: "email", message: CODE_STEP_COPY.invalidEmail };
    case "WEBSITE_CODE_INVALID":
      return { ...base, field: "code", message: CODE_STEP_COPY.wrongCode };
    case "WEBSITE_CODE_EXPIRED":
      return { ...base, field: "code", message: CODE_STEP_COPY.expiredCode };
    case "WEBSITE_CODE_LOCKED":
      if (during === "resend") return { ...base, field, message: fillCopy(CODE_STEP_COPY.resendCap, { minutes: minutesOf(retry) }) };
      return { ...base, field, message: fillCopy(CODE_STEP_COPY.locked, { minutes: minutesOf(retry) }) };
    case "WEBSITE_CODE_RATE_LIMITED":
      return { ...base, field, message: fillCopy(CODE_STEP_COPY.locked, { minutes: minutesOf(retry) }) };
    case "WEBSITE_TERMS_REQUIRED":
      return { ...base, field: "terms", message: CODE_STEP_COPY.terms };
    default:
      return { ...base, field, message: CODE_STEP_COPY.otherError };
  }
}

/** Invalid or expired: the buyer types again, so focus goes back to the input. */
const refocuses = (reason: string) => reason === "WEBSITE_CODE_INVALID" || reason === "WEBSITE_CODE_EXPIRED";

function codeOpened(state: CodeStepState, fields: Partial<CodeStepState>, now: number): CodeStepState {
  const resendAt = fields.resendAvailableAt ?? null;
  return {
    ...state,
    ...fields,
    step: "code",
    countdownFrom: resendAt === null ? 0 : Math.max(0, Math.ceil((resendAt - now) / 1000)),
    resending: false,
    error: null,
    focusCode: state.focusCode + 1,
  };
}

export function codeStepReducer(state: CodeStepState, action: CodeStepAction): CodeStepState {
  switch (action.type) {
    case "send":
      if (state.step !== "email") return state;
      return { ...state, step: "sending", email: action.email.trim(), error: null };
    case "sent": {
      if (state.step !== "sending" && !(state.step === "code" && state.resending)) return state;
      const t = action.ticket;
      return codeOpened(
        state,
        {
          ...(action.email ? { email: action.email } : {}),
          codeLength: t.codeLength,
          codeExpiresAt: action.now + t.codeExpiresInSeconds * 1000,
          resendAvailableAt: Date.parse(t.resendAvailableAt),
        },
        action.now,
      );
    }
    case "resend":
      if (state.step !== "code" || state.resending) return state;
      return { ...state, resending: true, error: null };
    case "verify":
      if (state.step !== "code" || state.resending) return state;
      return { ...state, step: "verifying", error: null };
    case "pay":
      if (state.step !== "confirm-price" && state.step !== "pay-failed") return state;
      return { ...state, step: "paying", error: null };
    case "answered": {
      if (state.step !== "verifying" && state.step !== "paying") return state;
      const a = action.answer;
      if (a.kind === "redirect") return { ...state, step: "paying", error: null };
      if (a.kind === "already-owned") return { ...state, step: "owned", error: null, settled: a.settled === true };
      if (a.kind === "confirm-price") {
        return { ...state, step: "confirm-price", error: null, price: { totalMinor: a.totalMinor, currencyCode: a.currencyCode, minorUnitExponent: a.minorUnitExponent } };
      }
      // payment-failed: the proof is gone → verify again from the email step (the email is kept).
      if ((PROOF_GONE_REASONS as readonly string[]).includes(a.reason)) {
        return { ...initialCodeStep({ email: state.email, termsRequired: state.termsRequired }), error: codeStepError({ reason: a.reason }, "start") };
      }
      return { ...state, step: "pay-failed", error: codeStepError({ reason: a.reason }, "pay") };
    }
    case "failed": {
      if (state.step === "sending") return { ...state, step: "email", error: codeStepError(action.refusal, "start") };
      if (state.step === "paying") return { ...state, step: "pay-failed", error: codeStepError(action.refusal, "pay") };
      const resending = state.step === "code" && state.resending;
      if (state.step !== "verifying" && !resending) return state;
      const error = codeStepError(action.refusal, resending ? "resend" : "verify");
      const next: CodeStepState = { ...state, step: "code", resending: false, error };
      if (refocuses(error.reason)) next.focusCode = state.focusCode + 1;
      if (error.field === "terms") {
        next.termsRequired = true;
        next.focusTerms = state.focusTerms + 1;
      }
      // E5: the resend cap holds "Send a new code" for the wait.
      if (resending && error.retryAfterSeconds !== null) {
        next.resendAvailableAt = action.now + error.retryAfterSeconds * 1000;
        next.countdownFrom = error.retryAfterSeconds;
      }
      return next;
    }
    case "terms": {
      // Ticking the box clears its own error: the step is recoverable.
      const error = state.error?.field === "terms" && action.accepted ? null : state.error;
      return { ...state, termsAccepted: action.accepted, error };
    }
    case "changeEmail":
      if (state.step !== "code" && state.step !== "email" && state.step !== "pay-failed" && state.step !== "confirm-price") return state;
      return initialCodeStep({ email: state.email, termsRequired: state.termsRequired });
    case "restore": {
      if (state.step !== "email") return state;
      const p = action.pending;
      return codeOpened(
        state,
        { email: p.email, codeLength: p.codeLength, codeExpiresAt: Date.parse(p.codeExpiresAt), resendAvailableAt: Date.parse(p.resendAvailableAt) },
        action.now,
      );
    }
    default:
      return state;
  }
}

/** The resend link at time `now`: its countdown, label and whether it may be used. */
export function resendCountdown(state: CodeStepState, now: number): { seconds: number; label: string; canResend: boolean } {
  const seconds = state.resendAvailableAt === null ? 0 : Math.max(0, Math.ceil((state.resendAvailableAt - now) / 1000));
  return {
    seconds,
    label: seconds > 0 ? fillCopy(CODE_STEP_COPY.resendWaiting, { seconds }) : CODE_STEP_COPY.resendReady,
    canResend: state.step === "code" && !state.resending && seconds === 0,
  };
}

/**
 * What the step's polite live region says (§8 accessibility). It changes only
 * when the countdown starts ("Send a new code in 60s", once) and when it is
 * ready ("Send a new code"), and says "Taking you to payment…" while going to
 * payment; it never ticks every second. Empty otherwise.
 */
export function codeStepAnnouncement(state: CodeStepState, now: number): string {
  if (state.step === "paying") return CODE_STEP_COPY.goingToPayment;
  if (state.step !== "code" || state.resendAvailableAt === null) return "";
  if (resendCountdown(state, now).seconds > 0) return fillCopy(CODE_STEP_COPY.resendWaiting, { seconds: state.countdownFrom });
  return CODE_STEP_COPY.resendReady;
}

/** A pasted or typed code: digits only ("123 456" → "123456"), then at most `length` of them. */
export function normalizeCode(value: string, length = 6): string {
  return value.replace(/\D/g, "").slice(0, Math.max(1, length));
}

/** A minor-unit total as money, e.g. `formatAmount({ totalMinor: "4900", minorUnitExponent: 2, currencyCode: "USD" })` → "$49.00". */
export function formatAmount(price: CodeStepPrice, locale = "en-US"): string {
  const major = Number(price.totalMinor) / 10 ** price.minorUnitExponent;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: price.currencyCode,
      minimumFractionDigits: price.minorUnitExponent,
      maximumFractionDigits: price.minorUnitExponent,
    }).format(major);
  } catch {
    return `${major.toFixed(price.minorUnitExponent)} ${price.currencyCode}`;
  }
}
