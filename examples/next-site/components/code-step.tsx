"use client";
// Checkout v3.1: the buyer verifies their email by code before paying, when the
// workspace's websiteCheckoutStatus.verifyEmail is "before-payment". The kit
// runs the step (useCodeStep); the site only draws it. The copy is the kit's
// CODE_STEP_COPY: a site may restyle it, never reword it.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { CODE_STEP_COPY, fillCopy, useCodeStep } from "@zwingd-ce/website-kit-next/client";

export function CodeStep(props: { offer: string; termsUrl?: string }) {
  const router = useRouter();
  const step = useCodeStep({ offer: props.offer });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const { state } = step;

  // Signed in on the website now: the server page shows the member price and Buy now.
  useEffect(() => {
    if (state.step === "verified") router.refresh();
  }, [state.step, router]);

  const terms = props.termsUrl ? (
    <p>
      {CODE_STEP_COPY.terms.split("{terms link}")[0]}
      <a href={props.termsUrl}>terms</a>
      {CODE_STEP_COPY.terms.split("{terms link}")[1]}
    </p>
  ) : null;

  if (state.step === "email" || state.step === "sending") {
    return (
      <form onSubmit={(e) => { e.preventDefault(); void step.sendCode(email); }}>
        <label htmlFor="buyer-email">Email</label>
        <input id="buyer-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        {terms}
        <button type="submit" disabled={step.busy}>Send code</button>
        {state.error ? <p role="alert">{state.error.message}</p> : null}
      </form>
    );
  }

  if (state.step === "verified") return state.notice === "account-ready" ? <p role="status">{CODE_STEP_COPY.accountReady}</p> : null;

  return (
    <form onSubmit={(e) => { e.preventDefault(); void step.verify(code); }}>
      <h2>{CODE_STEP_COPY.heading}</h2>
      <p>{fillCopy(CODE_STEP_COPY.intro, { email: state.email })}</p>
      <label htmlFor="buyer-code">{CODE_STEP_COPY.codeLabel}</label>
      <input
        id="buyer-code"
        ref={step.codeInputRef}
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={state.codeLength}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        aria-describedby={state.error ? "buyer-code-error buyer-code-hint" : "buyer-code-hint"}
      />
      <p id="buyer-code-hint">{CODE_STEP_COPY.hint}</p>
      {state.error ? <p id="buyer-code-error" role="alert">{state.error.message}</p> : null}
      {terms}
      <button type="submit" disabled={step.busy}>{CODE_STEP_COPY.verifyButton}</button>
      <button type="button" onClick={() => void step.resend()} disabled={!step.canResend}>{step.resendLabel}</button>
      <button type="button" onClick={step.changeEmail} disabled={step.busy}>{CODE_STEP_COPY.changeEmail}</button>
    </form>
  );
}
