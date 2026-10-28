"use client";
/**
 * The code step before payment (checkout v3.1, spec §6) as a headless hook:
 * the page draws the step its own way, the kit runs it.
 *
 *   const step = useCodeStep({ offer });
 *   step.sendCode(email)          // email → sending → code
 *   step.verify(code, { acceptedDocuments })  // code → verifying → verified
 *   step.resend(), step.changeEmail()
 *   step.state.error?.message     // the spec's line for the refusal
 *   step.resendLabel              // "Send a new code in 42s" / "Send a new code"
 *   <input ref={step.codeInputRef} autoComplete="one-time-code" inputMode="numeric" />
 *
 * After `verified` the buyer is signed in on the website (the kit set the
 * session cookie): continue as a member (member quote, `startMemberCheckout`
 * with `state.signOutToken`). `state.notice === "account-ready"` shows "Your
 * account is ready." once; never store it or send it anywhere.
 *
 * The form value (`csrf`) comes from GET /session/code-step unless given, and
 * the same read resumes an open step after a reload (the ticket cookie).
 */
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";

import {
  codeStepReducer,
  initialCodeStep,
  resendCountdown,
  UNAVAILABLE_REASON,
  type AcceptedDocument,
  type CodeStepRead,
  type CodeStepRefusal,
  type CodeStepState,
  type CodeStepTicket,
  type CodeStepVerified,
} from "@zwingd-ce/website-kit";

export interface UseCodeStepOptions {
  /** Where the kit's routes are mounted. Default `/session`. */
  basePath?: string;
  /** The `csrf` value, when the page already has it; else read from GET /session/code-step. */
  formToken?: string | null;
  /** The offer being bought (24 hex), for the drop-off report. */
  offer?: string;
  /** Resume an open step after a reload. Default true. */
  resume?: boolean;
  /** The email to start with (e.g. what the buyer typed before). */
  initialEmail?: string;
  /** For tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface VerifyExtras {
  firstName?: string;
  lastName?: string;
  /** The workspace's legal documents the step showed (spec §2a). */
  acceptedDocuments?: AcceptedDocument[];
}

export interface CodeStep {
  state: CodeStepState;
  /** Seconds until "Send a new code" is ready. */
  secondsLeft: number;
  /** "Send a new code in {seconds}s" or "Send a new code". */
  resendLabel: string;
  canResend: boolean;
  /** True while a send, resend or verify is in flight: disable the buttons. */
  busy: boolean;
  sendCode(email: string, extras?: { botToken?: string }): Promise<void>;
  resend(): Promise<void>;
  verify(code: string, extras?: VerifyExtras): Promise<void>;
  changeEmail(): void;
  /** Put it on the code input: focus moves there when the step opens and after an invalid or expired code. */
  codeInputRef: RefObject<HTMLInputElement | null>;
}

type Answer<T> = { ok: true; body: T } | { ok: false; refusal: CodeStepRefusal };

const unavailable = (): { ok: false; refusal: CodeStepRefusal } => ({ ok: false, refusal: { reason: UNAVAILABLE_REASON } });

/** The browser side of the kit's code routes. Never throws. */
export function createCodeStepClient(options: { basePath?: string; fetch?: typeof fetch } = {}) {
  const base = (options.basePath ?? "/session").replace(/\/+$/, "");
  const doFetch = (...args: Parameters<typeof fetch>) => (options.fetch ?? globalThis.fetch)(...args);

  async function postForm<T>(path: string, form: Record<string, string>): Promise<Answer<T>> {
    try {
      const res = await doFetch(`${base}/${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && body) return { ok: true, body: body as T };
      if (body && typeof body.reason === "string") return { ok: false, refusal: body as unknown as CodeStepRefusal };
      return unavailable();
    } catch {
      return unavailable();
    }
  }

  return {
    async read(): Promise<CodeStepRead | null> {
      try {
        const res = await doFetch(`${base}/code-step`, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" });
        if (!res.ok) return null;
        const body = (await res.json()) as CodeStepRead;
        return typeof body?.formToken === "string" ? body : null;
      } catch {
        return null;
      }
    },
    start: (form: Record<string, string>) => postForm<CodeStepTicket>("code-start", form),
    resend: (form: Record<string, string>) => postForm<CodeStepTicket>("code-resend", form),
    verify: (form: Record<string, string>) => postForm<CodeStepVerified>("code-verify", form),
  };
}

export function useCodeStep(options: UseCodeStepOptions = {}): CodeStep {
  const now = options.now ?? Date.now;
  const [state, dispatch] = useReducer(codeStepReducer, options.initialEmail ?? "", initialCodeStep);
  const [clock, setClock] = useState(() => now());
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const inFlight = useRef(false);
  const token = useRef<string | null>(options.formToken ?? null);
  const clientRef = useRef<ReturnType<typeof createCodeStepClient> | null>(null);
  clientRef.current ??= createCodeStepClient({ ...(options.basePath ? { basePath: options.basePath } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
  const client = clientRef.current;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (options.formToken) token.current = options.formToken;
  }, [options.formToken]);

  // Resume an open step after a reload (and learn the form value).
  useEffect(() => {
    if (options.resume === false && token.current) return;
    let live = true;
    void client.read().then((read) => {
      if (!live || !read) return;
      token.current ??= read.formToken;
      if (options.resume !== false && read.pending) dispatch({ type: "restore", pending: read.pending });
    });
    return () => {
      live = false;
    };
    // Once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The countdown ticks once a second while it runs.
  const waiting = state.step === "code" && state.resendAvailableAt !== null && state.resendAvailableAt > clock;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setClock(now()), 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);
  useEffect(() => {
    if (state.step === "code") setClock(now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.resendAvailableAt, state.step]);

  useEffect(() => {
    if (state.focusCode > 0) codeInputRef.current?.focus();
  }, [state.focusCode]);

  async function formToken(): Promise<string | null> {
    if (token.current) return token.current;
    const read = await client.read();
    token.current = read?.formToken ?? null;
    return token.current;
  }

  /** The double-submit guard: one call at a time, whatever the buttons do. */
  async function once(run: () => Promise<void>): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await run();
    } finally {
      inFlight.current = false;
    }
  }

  const sendCode = useCallback(
    (email: string, extras: { botToken?: string } = {}) =>
      once(async () => {
        if (stateRef.current.step !== "email") return;
        dispatch({ type: "send", email });
        const csrf = await formToken();
        if (!csrf) return dispatch({ type: "failed", refusal: { reason: UNAVAILABLE_REASON } });
        const res = await client.start({
          csrf,
          email: email.trim(),
          ...(options.offer ? { offer: options.offer } : {}),
          ...(extras.botToken ? { botToken: extras.botToken } : {}),
        });
        dispatch(res.ok ? { type: "sent", ticket: res.body, now: now() } : { type: "failed", refusal: res.refusal });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.offer],
  );

  const resend = useCallback(
    () =>
      once(async () => {
        const s = stateRef.current;
        if (!resendCountdown(s, now()).canResend) return;
        dispatch({ type: "resend" });
        const csrf = await formToken();
        if (!csrf) return dispatch({ type: "failed", refusal: { reason: UNAVAILABLE_REASON } });
        const res = await client.resend({ csrf });
        dispatch(res.ok ? { type: "sent", ticket: res.body, now: now() } : { type: "failed", refusal: res.refusal });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const verify = useCallback(
    (code: string, extras: VerifyExtras = {}) =>
      once(async () => {
        const s = stateRef.current;
        if (s.step !== "code" || s.resending) return;
        dispatch({ type: "verify" });
        const csrf = await formToken();
        if (!csrf) return dispatch({ type: "failed", refusal: { reason: UNAVAILABLE_REASON } });
        const res = await client.verify({
          csrf,
          code: code.replace(/\s+/g, ""),
          ...(extras.firstName ? { firstName: extras.firstName } : {}),
          ...(extras.lastName ? { lastName: extras.lastName } : {}),
          ...(extras.acceptedDocuments && extras.acceptedDocuments.length > 0 ? { acceptedDocuments: JSON.stringify(extras.acceptedDocuments) } : {}),
        });
        if (res.ok) {
          token.current = res.body.signOutToken;
          dispatch({ type: "verified", answer: res.body });
        } else {
          dispatch({ type: "failed", refusal: res.refusal });
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const changeEmail = useCallback(() => {
    if (!inFlight.current) dispatch({ type: "changeEmail" });
  }, []);

  const countdown = resendCountdown(state, clock);
  return {
    state,
    secondsLeft: countdown.seconds,
    resendLabel: countdown.label,
    canResend: countdown.canResend,
    busy: state.step === "sending" || state.step === "verifying" || state.resending,
    sendCode,
    resend,
    verify,
    changeEmail,
    codeInputRef,
  };
}
