"use client";
/**
 * The code step before payment (checkout v3.2, spec §8, §8a, A2) as a
 * headless hook: the page draws the step its own way, the kit runs it.
 *
 *   const step = useCodeStep({ offer, expectedTotalMinor, expectedCurrencyCode, country, workspaceName, storageKey, terms });
 *   <input {...step.emailInputProps} value={email} onChange={...} />
 *   step.sendCode(email)                 // email → sending → code (focus moves to the code input)
 *   <input {...step.codeInputProps} />   // one input: paste "123 456" works; Tab leaves it
 *   <input {...step.termsInputProps} />  // "I agree to the {terms links}." when the workspace requires terms
 *   step.verify()                        // code → verifying → paying (straight to payment)
 *                                        //                 → confirm-price ("Your member price is {amount}.")
 *   step.pay()                           // "Pay {amount}" → paying
 *   <CodeStepLiveRegion step={step} />   // the polite countdown / "Taking you to payment…" region
 *
 * The code step creates no account and no session. The proof stays on the
 * site's server (HttpOnly cookie): nothing here ever sees it. The order token
 * is kept in this tab's sessionStorage under `storageKey` before the browser
 * goes to payment, as for member checkout.
 *
 * The form value (`csrf`) comes from GET /session/code-step unless given, and
 * the same read resumes an open step after a reload (the ticket cookie), or,
 * once the code was right and the proof is still held for this offer, the
 * step at "Pay {amount}" (`resuming` → `confirm-price`, Helm #18 on #1963).
 */
import { useCallback, useEffect, useId, useReducer, useRef, useState, type ChangeEvent, type RefObject } from "react";

import {
  CHECKOUT_ATTRIBUTION_KEYS,
  CODE_STEP_COPY,
  codeStepAnnouncement,
  codeStepReducer,
  fillCopy,
  formatAmount,
  initialCodeStep,
  normalizeCode,
  resendCountdown,
  storeCheckoutOrder,
  UNAVAILABLE_REASON,
  type AcceptedDocument,
  type CheckoutAttribution,
  type CheckoutStorage,
  type CodeStepPayment,
  type CodeStepPrice,
  type CodeStepRead,
  type CodeStepRefusal,
  type CodeStepState,
  type CodeStepTicket,
  type HeldCodeStep,
} from "@zwingd-ce/website-kit";

export interface UseCodeStepOptions {
  /** The offer being bought (24 hex). */
  offer: string;
  /** The total the page showed (minor units). Unchanged after the re-quote → straight to payment (A2). */
  expectedTotalMinor: string;
  /**
   * The currency of that total (ISO 4217, e.g. "USD", as the quote answers it). A re-quote with the same number
   * in another currency is a changed price (A2): the buyer sees it and presses "Pay {amount}".
   */
  expectedCurrencyCode: string;
  paymentGateway?: string;
  couponCode?: string;
  /**
   * The country the page priced `expectedTotalMinor` in, as a master-data
   * country id (24 hex, the `_id` your guest quote and start take as
   * `country`), e.g. the one the buyer picked in your pop-up. It goes with the
   * code start and the re-quote after the code as the API's FALLBACK country:
   * a verified member is priced in their profile country first (A2, Helm #23),
   * a non-member sees the same total. Without it the kit's `visitorCountry`
   * setting (the geo header) is used. With neither, no code is sent: the start
   * is refused `COUNTRY_REQUIRED` (field `country`) for every email alike
   * (Helm #4), so ask for the country and send the code again.
   */
  country?: string | null;
  /**
   * The workspace's name as the buyer knows it: "We couldn't take this payment. Try again, or contact
   * {workspace}." (Helm #16).
   */
  workspaceName: string;
  attribution?: CheckoutAttribution;
  /** The site's sessionStorage key for an order, exactly as its return page reads it. */
  storageKey: (orderId: string) => string;
  /** The course page the buyer started on, kept in the order record. */
  coursePath?: string | null;
  /**
   * The workspace's legal documents when it requires terms: the tick box
   * shows, and a ticked box sends them as `acceptedDocuments`. Same for every
   * buyer, new or existing (no enumeration).
   */
  terms?: AcceptedDocument[];
  /** Where the kit's routes are mounted. Default `/session`. */
  basePath?: string;
  /** The `csrf` value, when the page already has it; else read from GET /session/code-step. */
  formToken?: string | null;
  /** Resume an open step (or a held proof, at "Pay {amount}") after a reload. Default true. */
  resume?: boolean;
  /** The email to start with (e.g. what the buyer typed before). */
  initialEmail?: string;
  /** How `{amount}` reads. Default `formatAmount(price, "en-US")`. */
  formatAmount?: (price: CodeStepPrice) => string;
  /** For tests and other runtimes. Defaults: the global `fetch`, `sessionStorage`, `location.assign`, `Date.now`. */
  fetch?: typeof fetch;
  storage?: CheckoutStorage | null;
  navigate?: (url: string) => void;
  now?: () => number;
}

export interface VerifyExtras {
  firstName?: string;
  lastName?: string;
}

/** The ids the step's inputs and lines use, so each error is tied to its input. */
export interface CodeStepIds {
  email: string;
  emailError: string;
  code: string;
  codeHint: string;
  codeError: string;
  terms: string;
  termsError: string;
  paymentError: string;
}

export interface CodeStep {
  state: CodeStepState;
  /** The code typed or pasted so far: digits only, at most the code's length. */
  code: string;
  setCode(value: string): void;
  /** Seconds until "Send a new code" is ready. */
  secondsLeft: number;
  /** "Send a new code in {seconds}s" or "Send a new code" (visible; NOT a live region). */
  resendLabel: string;
  canResend: boolean;
  /** What the polite live region says: at the countdown's start, when it is ready, and "Taking you to payment…". */
  announcement: string;
  /** True while a send, resend, verify or pay is in flight: disable the buttons. */
  busy: boolean;
  /** `confirm-price`: the member price as text, "Your member price is {amount}." and "Pay {amount}". */
  amount: string | null;
  priceLine: string | null;
  payLabel: string | null;
  sendCode(email: string, extras?: { botToken?: string }): Promise<void>;
  resend(): Promise<void>;
  verify(extras?: VerifyExtras): Promise<void>;
  pay(): Promise<void>;
  changeEmail(): void;
  setTermsAccepted(accepted: boolean): void;
  ids: CodeStepIds;
  codeInputRef: RefObject<HTMLInputElement | null>;
  termsInputRef: RefObject<HTMLInputElement | null>;
  /** Spread on the email input (the page keeps its value). */
  emailInputProps: {
    id: string;
    name: "email";
    type: "email";
    autoComplete: "email";
    "aria-invalid": boolean;
    "aria-describedby": string | undefined;
  };
  /** Spread on the ONE code input. No `maxLength`: a pasted "123 456" is stripped first, then cut to length. */
  codeInputProps: {
    id: string;
    name: "code";
    ref: RefObject<HTMLInputElement | null>;
    value: string;
    onChange(event: ChangeEvent<HTMLInputElement>): void;
    type: "text";
    autoComplete: "one-time-code";
    inputMode: "numeric";
    "aria-invalid": boolean;
    "aria-describedby": string;
  };
  /** Spread on the terms tick box (draw it when `state.termsRequired`). */
  termsInputProps: {
    id: string;
    name: "terms";
    ref: RefObject<HTMLInputElement | null>;
    type: "checkbox";
    checked: boolean;
    onChange(event: ChangeEvent<HTMLInputElement>): void;
    required: true;
    "aria-invalid": boolean;
    "aria-describedby": string | undefined;
  };
}

/** `forbidden`: the kit refused the POST itself (403, the same-site rule) before any API call, e.g. a stale form value. */
type Answer<T> = { ok: true; body: T } | { ok: false; refusal: CodeStepRefusal; forbidden?: true };

const unavailable = (): { ok: false; refusal: CodeStepRefusal } => ({ ok: false, refusal: { reason: UNAVAILABLE_REASON } });

/** The purchase shapes the kit's server takes: a held proof waits until the page has them. */
const EXPECTED_TOTAL = /^\d{1,18}$/;
const CURRENCY = /^[A-Z]{3}$/;

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
      if (res.status === 403) return { ...unavailable(), forbidden: true };
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && body) return { ok: true, body: body as T };
      if (body && typeof body.reason === "string") return { ok: false, refusal: body as unknown as CodeStepRefusal };
      return unavailable();
    } catch {
      return unavailable();
    }
  }

  /** A 200 that is not a ticket (a proxy page, a version skew) would break the step: it reads as no answer. */
  const ticketOnly = (res: Answer<unknown>): Answer<CodeStepTicket> => (!res.ok ? res : isTicket(res.body) ? { ok: true, body: res.body } : unavailable());

  return {
    async read(): Promise<CodeStepRead | null> {
      try {
        const res = await doFetch(`${base}/code-step`, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" });
        if (!res.ok) return null;
        const body = (await res.json()) as CodeStepRead;
        if (typeof body?.formToken !== "string") return null;
        // An open step the hook cannot run on is not resumed: the form value still counts.
        return { formToken: body.formToken, pending: isPending(body.pending) ? body.pending : null, held: isHeld(body.held) ? body.held : null };
      } catch {
        return null;
      }
    },
    start: async (form: Record<string, string>): Promise<Answer<CodeStepTicket>> => ticketOnly(await postForm<unknown>("code-start", form)),
    resend: async (form: Record<string, string>): Promise<Answer<CodeStepTicket>> => ticketOnly(await postForm<unknown>("code-resend", form)),
    verify: (form: Record<string, string>) => postForm<CodeStepPayment>("code-verify", form),
    pay: (form: Record<string, string>) => postForm<CodeStepPayment>("code-pay", form),
    requote: (form: Record<string, string>) => postForm<CodeStepPayment>("code-requote", form),
  };
}

const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** A ticket answer the step can run on: a code length of 4-12, a positive life, a real resend time. */
function isTicket(value: unknown): value is CodeStepTicket {
  const v = value as Record<string, unknown> | null;
  return (
    !!v &&
    typeof v === "object" &&
    Number.isInteger(v.codeLength) &&
    (v.codeLength as number) >= 4 &&
    (v.codeLength as number) <= 12 &&
    typeof v.codeExpiresInSeconds === "number" &&
    v.codeExpiresInSeconds > 0 &&
    isTime(v.resendAvailableAt)
  );
}

function isPending(value: unknown): boolean {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v === "object" && typeof v.email === "string" && Number.isInteger(v.codeLength) && isTime(v.codeExpiresAt) && isTime(v.resendAvailableAt);
}

function isHeld(value: unknown): value is HeldCodeStep {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v === "object" && typeof v.email === "string" && (v.offer === null || typeof v.offer === "string");
}

function isPayment(value: unknown): value is CodeStepPayment {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object") return false;
  if (v.kind === "redirect") return typeof v.url === "string" && /^https?:\/\//.test(v.url) && typeof v.orderId === "string";
  if (v.kind === "confirm-price") return typeof v.totalMinor === "string" && typeof v.currencyCode === "string" && typeof v.minorUnitExponent === "number";
  if (v.kind === "payment-failed") return typeof v.reason === "string";
  return v.kind === "already-owned";
}

export function useCodeStep(options: UseCodeStepOptions): CodeStep {
  const now = options.now ?? Date.now;
  // Live, not only at mount: a site often loads the workspace's legal documents after the first render.
  const termsGiven = (options.terms?.length ?? 0) > 0;
  const [reduced, dispatch] = useReducer(codeStepReducer, { email: options.initialEmail ?? "", termsRequired: termsGiven }, initialCodeStep);
  const withTerms: CodeStepState = termsGiven && !reduced.termsRequired ? { ...reduced, termsRequired: true } : reduced;
  // The one line with the workspace in it (#16): filled here, where the name is known.
  const state: CodeStepState =
    withTerms.error && withTerms.error.message.includes("{workspace}")
      ? { ...withTerms, error: { ...withTerms.error, message: fillCopy(withTerms.error.message, { workspace: options.workspaceName }) } }
      : withTerms;
  const [code, setCodeValue] = useState("");
  const [clock, setClock] = useState(() => now());
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const termsInputRef = useRef<HTMLInputElement | null>(null);
  const inFlight = useRef(false);
  const token = useRef<string | null>(options.formToken ?? null);
  const clientRef = useRef<ReturnType<typeof createCodeStepClient> | null>(null);
  clientRef.current ??= createCodeStepClient({ ...(options.basePath ? { basePath: options.basePath } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
  const client = clientRef.current;
  const stateRef = useRef(state);
  stateRef.current = state;
  const codeRef = useRef(code);
  codeRef.current = code;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const uid = useId().replace(/:/g, "");
  const ids: CodeStepIds = {
    email: `zw-${uid}-email`,
    emailError: `zw-${uid}-email-error`,
    code: `zw-${uid}-code`,
    codeHint: `zw-${uid}-code-hint`,
    codeError: `zw-${uid}-code-error`,
    terms: `zw-${uid}-terms`,
    termsError: `zw-${uid}-terms-error`,
    paymentError: `zw-${uid}-payment-error`,
  };

  useEffect(() => {
    if (options.formToken) token.current = options.formToken;
  }, [options.formToken]);

  // A held proof from the read, waiting for the page's purchase (a price may still be loading).
  const [held, setHeld] = useState<HeldCodeStep | null>(null);

  // Resume an open step after a reload (and learn the form value).
  useEffect(() => {
    if (options.resume === false && token.current) return;
    let live = true;
    void client.read().then((read) => {
      if (!live || !read) return;
      token.current ??= read.formToken;
      if (options.resume === false) return;
      if (read.pending) dispatch({ type: "restore", pending: read.pending, now: now() });
      else if (read.held) setHeld(read.held);
    });
    return () => {
      live = false;
    };
    // Once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Helm #18: a proof held for THIS offer resumes at "Pay {amount}", once the page knows the price it shows.
  const purchaseReady = EXPECTED_TOTAL.test(options.expectedTotalMinor) && CURRENCY.test(options.expectedCurrencyCode);
  useEffect(() => {
    if (!held || !purchaseReady || (held.offer !== null && held.offer !== options.offer)) return;
    setHeld(null);
    void once(async () => {
      if (stateRef.current.step !== "email") return;
      dispatch({ type: "resume", email: held.email });
      const o = optionsRef.current;
      settle(await withFormToken((csrf) => client.requote({ csrf, ...purchaseForm(o.expectedTotalMinor, o.expectedCurrencyCode) })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, purchaseReady, options.offer]);

  // The countdown ticks once a second while it runs (the visible label only).
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

  // Focus moves to the code input when the step opens and after an invalid or expired code.
  useEffect(() => {
    if (state.focusCode > 0) codeInputRef.current?.focus();
  }, [state.focusCode]);
  useEffect(() => {
    if (state.focusTerms > 0) termsInputRef.current?.focus();
  }, [state.focusTerms]);
  // A new code to type (the step opened, or a new code was sent): the old one is cleared. Only when `focusCode`
  // moves: an error going away (ticking the terms box clears the terms error) must never wipe what was typed.
  const clearedFor = useRef(0);
  useEffect(() => {
    if (state.focusCode === clearedFor.current) return;
    clearedFor.current = state.focusCode;
    if (state.focusCode > 0 && state.error === null) setCodeValue("");
  }, [state.focusCode, state.error]);

  async function formToken(): Promise<string | null> {
    if (token.current) return token.current;
    const read = await client.read();
    token.current = read?.formToken ?? null;
    return token.current;
  }

  /**
   * One POST with the form value. A 403 means the value went stale (e.g. /session/me dropped the cookie for an
   * ended session while the step was open): the kit refused before calling the API, so nothing was spent, and the
   * POST is sent again ONCE with a fresh value.
   */
  async function withFormToken<T>(send: (csrf: string) => Promise<Answer<T>>): Promise<Answer<T>> {
    const csrf = await formToken();
    if (!csrf) return unavailable();
    const res = await send(csrf);
    if (res.ok || !res.forbidden) return res;
    token.current = null;
    const fresh = await formToken();
    return fresh && fresh !== csrf ? send(fresh) : res;
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

  function purchaseForm(expectedTotalMinor: string, expectedCurrencyCode: string): Record<string, string> {
    const o = optionsRef.current;
    const form: Record<string, string> = { offer: o.offer, expectedTotalMinor, expectedCurrencyCode };
    if (o.paymentGateway) form.paymentGateway = o.paymentGateway;
    if (o.couponCode) form.couponCode = o.couponCode;
    if (o.country) form.country = o.country;
    for (const key of CHECKOUT_ATTRIBUTION_KEYS) {
      const value = o.attribution?.[key];
      if (typeof value === "string" && value !== "") form[key] = value;
    }
    return form;
  }

  /** The verify or pay answer: keep the order, then go to payment; or show what came back. */
  function settle(answer: Answer<CodeStepPayment>): void {
    if (!answer.ok) return dispatch({ type: "failed", refusal: answer.refusal, now: now() });
    const a = answer.body;
    if (!isPayment(a)) return dispatch({ type: "failed", refusal: { reason: UNAVAILABLE_REASON }, now: now() });
    if (a.kind !== "redirect") return dispatch({ type: "answered", answer: a });
    const o = optionsRef.current;
    const kept = storeCheckoutOrder(a, {
      storageKey: o.storageKey,
      coursePath: o.coursePath ?? null,
      member: false,
      ...(o.storage === undefined ? {} : { storage: o.storage }),
    });
    if (!kept) {
      // A settled order is the buyer's now, whatever happened to its token (kit #5).
      if (a.settled) return dispatch({ type: "answered", answer: { kind: "already-owned", settled: true } });
      return dispatch({ type: "answered", answer: { kind: "payment-failed", reason: "STORAGE_UNAVAILABLE" } });
    }
    dispatch({ type: "answered", answer: a });
    const navigate = o.navigate ?? ((url: string) => (globalThis as { location?: { assign(u: string): void } }).location?.assign(url));
    navigate(a.url);
  }

  const sendCode = useCallback(
    (email: string, extras: { botToken?: string } = {}) =>
      once(async () => {
        if (stateRef.current.step !== "email") return;
        dispatch({ type: "send", email });
        const o = optionsRef.current;
        const res = await withFormToken((csrf) =>
          client.start({
            csrf,
            email: email.trim(),
            offer: o.offer,
            // Helm #4: the country goes with the start; with none known the kit's server sends no code.
            ...(o.country ? { country: o.country } : {}),
            ...(extras.botToken ? { botToken: extras.botToken } : {}),
          }),
        );
        dispatch(res.ok ? { type: "sent", ticket: res.body, now: now() } : { type: "failed", refusal: res.refusal, now: now() });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const resend = useCallback(
    () =>
      once(async () => {
        const s = stateRef.current;
        if (!resendCountdown(s, now()).canResend) return;
        dispatch({ type: "resend" });
        let res = await withFormToken((csrf) => client.resend({ csrf }));
        // §8: the ticket is gone altogether (cookie lost) → start again with the email the step holds.
        if (!res.ok && res.refusal.reason === "WEBSITE_CODE_EXPIRED" && s.email) {
          const o = optionsRef.current;
          res = await withFormToken((csrf) => client.start({ csrf, email: s.email, offer: o.offer, ...(o.country ? { country: o.country } : {}) }));
        }
        dispatch(res.ok ? { type: "sent", ticket: res.body, now: now() } : { type: "failed", refusal: res.refusal, now: now() });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const verify = useCallback(
    (extras: VerifyExtras = {}) =>
      once(async () => {
        const s = stateRef.current;
        if (s.step !== "code" || s.resending) return;
        dispatch({ type: "verify" });
        const o = optionsRef.current;
        // Terms required and not ticked: say so here, without spending a guess.
        if (s.termsRequired && !s.termsAccepted) return dispatch({ type: "failed", refusal: { reason: "WEBSITE_TERMS_REQUIRED" }, now: now() });
        const docs = s.termsAccepted ? (o.terms ?? []) : [];
        const res = await withFormToken((csrf) =>
          client.verify({
            csrf,
            code: normalizeCode(codeRef.current, s.codeLength),
            ...(extras.firstName ? { firstName: extras.firstName } : {}),
            ...(extras.lastName ? { lastName: extras.lastName } : {}),
            ...(docs.length > 0 ? { acceptedDocuments: JSON.stringify(docs) } : {}),
            ...purchaseForm(o.expectedTotalMinor, o.expectedCurrencyCode),
          }),
        );
        settle(res);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const pay = useCallback(
    () =>
      once(async () => {
        const s = stateRef.current;
        if (s.step !== "confirm-price" && s.step !== "pay-failed") return;
        dispatch({ type: "pay" });
        // The price the buyer was shown: the member price, else the page's own.
        const total = s.price?.totalMinor ?? optionsRef.current.expectedTotalMinor;
        const currency = s.price?.currencyCode ?? optionsRef.current.expectedCurrencyCode;
        settle(await withFormToken((csrf) => client.pay({ csrf, ...purchaseForm(total, currency) })));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const changeEmail = useCallback(() => {
    if (!inFlight.current) {
      setCodeValue("");
      dispatch({ type: "changeEmail" });
    }
  }, []);

  const setTermsAccepted = useCallback((accepted: boolean) => dispatch({ type: "terms", accepted }), []);
  const setCode = useCallback((value: string) => setCodeValue(normalizeCode(value, stateRef.current.codeLength)), []);

  const countdown = resendCountdown(state, clock);
  // Also after a failed "Pay {amount}": the retry still pays that price, so the page can still say it.
  const amount =
    (state.step === "confirm-price" || state.step === "pay-failed") && state.price ? (options.formatAmount ?? ((p: CodeStepPrice) => formatAmount(p)))(state.price) : null;
  const err = state.error;
  const describedBy = (...list: (string | false | undefined)[]) => list.filter(Boolean).join(" ") || undefined;

  return {
    state,
    code,
    setCode,
    secondsLeft: countdown.seconds,
    resendLabel: countdown.label,
    canResend: countdown.canResend,
    announcement: codeStepAnnouncement(state, clock),
    busy: state.step === "sending" || state.step === "verifying" || state.step === "resuming" || state.step === "paying" || state.resending,
    amount,
    priceLine: amount === null ? null : fillCopy(CODE_STEP_COPY.memberPrice, { amount }),
    payLabel: amount === null ? null : fillCopy(CODE_STEP_COPY.payButton, { amount }),
    sendCode,
    resend,
    verify,
    pay,
    changeEmail,
    setTermsAccepted,
    ids,
    codeInputRef,
    termsInputRef,
    emailInputProps: {
      id: ids.email,
      name: "email",
      type: "email",
      autoComplete: "email",
      "aria-invalid": err?.field === "email",
      "aria-describedby": describedBy(err?.field === "email" && ids.emailError),
    },
    codeInputProps: {
      id: ids.code,
      name: "code",
      ref: codeInputRef,
      value: code,
      onChange: (event) => setCode(event.target.value),
      type: "text",
      autoComplete: "one-time-code",
      inputMode: "numeric",
      "aria-invalid": err?.field === "code",
      "aria-describedby": describedBy(err?.field === "code" && ids.codeError, ids.codeHint)!,
    },
    termsInputProps: {
      id: ids.terms,
      name: "terms",
      ref: termsInputRef,
      type: "checkbox",
      checked: state.termsAccepted,
      onChange: (event) => setTermsAccepted(event.target.checked),
      required: true,
      "aria-invalid": err?.field === "terms",
      "aria-describedby": describedBy(err?.field === "terms" && ids.termsError),
    },
  };
}
