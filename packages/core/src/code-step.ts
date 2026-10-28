/**
 * The code step's copy and its headless state (checkout v3.1, spec §6): the
 * page draws the step, this decides what it says and when. Framework-free, so
 * `useCodeStep` (Next) and any other site use the same rules.
 *
 *   email ──send──► sending ──sent──► code ──verify──► verifying ──verified──► verified
 *     ▲                 │               │  ▲               │
 *     └─failed──────────┘               │  └──failed───────┘   (stays on the code step)
 *     └────────── changeEmail ──────────┘
 *
 * Errors are keyed by `reason`: invalid or expired code (stay, focus the
 * input), locked or rate-limited (the wait from `retryAfterSeconds`), anything
 * else the generic line. A send, resend or verify already in flight ignores a
 * second one (the double-submit guard).
 */

/** The step's copy, exactly as signed (spec §6). A site may restyle it, never reword it. */
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
  otherError: "We couldn't check your code. Try again.",
  resendCap: "You've asked for the most codes we can send for now. Try again in {minutes} min, or use a different email.",
  hint: "Didn't get a code? Check your spam folder, or use a different email.",
  /** `{terms link}` is where the site draws its link to the workspace's terms. */
  terms: "By continuing you agree to the {terms link}.",
  accountReady: "Your account is ready.",
});

export type CodeStepCopyKey = keyof typeof CODE_STEP_COPY;

/** A copy line with its `{name}` placeholders filled. */
export function fillCopy(line: string, values: Record<string, string | number>): string {
  return line.replace(/\{([a-z ]+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** The "you may continue" notice the verify answers the browser: display only, never stored. */
export type CodeStepNotice = "account-ready" | null;

export type CodeStepName = "email" | "sending" | "code" | "verifying" | "verified";

export interface CodeStepError {
  /** The API's reason (`WEBSITE_CODE_INVALID`, ...), or `UNAVAILABLE` when it could not answer. */
  reason: string;
  /** The line to show (spec §6 copy). */
  message: string;
  retryAfterSeconds: number | null;
  /** `WEBSITE_TERMS_REQUIRED`: the fields the workspace needs. */
  fields?: string[];
}

export interface CodeStepMember {
  firstName?: string;
  lastName?: string;
}

export interface CodeStepState {
  step: CodeStepName;
  email: string;
  codeLength: number;
  /** When the code stops working (ms), or null. */
  codeExpiresAt: number | null;
  /** When "Send a new code" is ready (ms), or null. */
  resendAvailableAt: number | null;
  /** True while a resend is in flight (the step stays `code`). */
  resending: boolean;
  error: CodeStepError | null;
  /** Bumped whenever focus should go to the code input (the step opened; an invalid or expired code). */
  focusCode: number;
  /** After verify: `account-ready` for a new account (show "Your account is ready."), else null. */
  notice: CodeStepNotice;
  member: CodeStepMember | null;
  /** After verify: the value forms post as `csrf` (sign-out, member checkout). */
  signOutToken: string | null;
}

/** What the kit's /session/code-start and /session/code-resend answer the browser. */
export interface CodeStepTicket {
  codeLength: number;
  codeExpiresInSeconds: number;
  resendAvailableAt: string;
}

/** What the kit's /session/code-verify answers the browser. Never `isNewAccount`. */
export interface CodeStepVerified {
  member: CodeStepMember;
  notice: CodeStepNotice;
  signOutToken: string;
}

/** A refusal as the kit's code routes answer it to the browser. */
export interface CodeStepRefusal {
  reason: string;
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
  | { type: "verified"; answer: CodeStepVerified }
  | { type: "failed"; refusal: CodeStepRefusal }
  | { type: "changeEmail" }
  | { type: "restore"; pending: PendingCodeStep };

export const UNAVAILABLE_REASON = "UNAVAILABLE";

export const initialCodeStep = (email = ""): CodeStepState => ({
  step: "email",
  email,
  codeLength: 6,
  codeExpiresAt: null,
  resendAvailableAt: null,
  resending: false,
  error: null,
  focusCode: 0,
  notice: null,
  member: null,
  signOutToken: null,
});

const minutesOf = (seconds: number | null): number => Math.max(1, Math.ceil((seconds ?? 60) / 60));

/** The line for a refusal, by reason only (the same reason always says the same thing). */
export function codeStepError(refusal: CodeStepRefusal): CodeStepError {
  const retry = typeof refusal.retryAfterSeconds === "number" ? refusal.retryAfterSeconds : null;
  const base = { reason: refusal.reason, retryAfterSeconds: retry, ...(refusal.fields ? { fields: refusal.fields } : {}) };
  switch (refusal.reason) {
    case "WEBSITE_CODE_INVALID":
      return { ...base, message: CODE_STEP_COPY.wrongCode };
    case "WEBSITE_CODE_EXPIRED":
      return { ...base, message: CODE_STEP_COPY.expiredCode };
    case "WEBSITE_CODE_LOCKED":
    case "WEBSITE_CODE_RATE_LIMITED":
      return { ...base, message: fillCopy(CODE_STEP_COPY.locked, { minutes: minutesOf(retry) }) };
    default:
      return { ...base, message: CODE_STEP_COPY.otherError };
  }
}

/** Invalid or expired: the buyer types again, so focus goes back to the input. */
const refocuses = (reason: string) => reason === "WEBSITE_CODE_INVALID" || reason === "WEBSITE_CODE_EXPIRED";

export function codeStepReducer(state: CodeStepState, action: CodeStepAction): CodeStepState {
  switch (action.type) {
    case "send":
      if (state.step !== "email") return state;
      return { ...state, step: "sending", email: action.email.trim(), error: null };
    case "sent": {
      if (state.step !== "sending" && !(state.step === "code" && state.resending)) return state;
      const t = action.ticket;
      return {
        ...state,
        step: "code",
        ...(action.email ? { email: action.email } : {}),
        codeLength: t.codeLength,
        codeExpiresAt: action.now + t.codeExpiresInSeconds * 1000,
        resendAvailableAt: Date.parse(t.resendAvailableAt),
        resending: false,
        error: null,
        focusCode: state.focusCode + 1,
      };
    }
    case "resend":
      if (state.step !== "code" || state.resending) return state;
      return { ...state, resending: true, error: null };
    case "verify":
      if (state.step !== "code" || state.resending) return state;
      return { ...state, step: "verifying", error: null };
    case "verified":
      if (state.step !== "verifying") return state;
      return {
        ...state,
        step: "verified",
        error: null,
        notice: action.answer.notice === "account-ready" ? "account-ready" : null,
        member: action.answer.member,
        signOutToken: action.answer.signOutToken,
      };
    case "failed": {
      const error = codeStepError(action.refusal);
      if (state.step === "sending") return { ...state, step: "email", error };
      if (state.step === "verifying" || (state.step === "code" && state.resending)) {
        return { ...state, step: "code", resending: false, error, focusCode: refocuses(error.reason) ? state.focusCode + 1 : state.focusCode };
      }
      return state;
    }
    case "changeEmail":
      if (state.step === "verifying" || state.step === "verified" || state.step === "sending") return state;
      return { ...initialCodeStep(state.email) };
    case "restore": {
      if (state.step !== "email") return state;
      const p = action.pending;
      return {
        ...state,
        step: "code",
        email: p.email,
        codeLength: p.codeLength,
        codeExpiresAt: Date.parse(p.codeExpiresAt),
        resendAvailableAt: Date.parse(p.resendAvailableAt),
        focusCode: state.focusCode + 1,
      };
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
