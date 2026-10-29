"use client";
// Checkout v3.2: the buyer proves their email by code before paying, when the
// workspace's websiteCheckoutStatus.verifyEmail is "before-payment". The kit
// runs the step (useCodeStep) and draws its live region; the site only draws
// the rest. The copy is the kit's CODE_STEP_COPY: restyle it, never reword it.
//
// No account and no session come from the code: the proof stays on the site's
// server. After a right code the buyer goes straight to payment, or, when the
// re-quote changed the total (member price), sees it and presses "Pay {amount}".
import { useState, type ReactNode } from "react";

import { CODE_STEP_COPY, CodeStepLiveRegion, fillCopy, useCodeStep, type AcceptedDocument } from "@zwingd-ce/website-kit-next/client";

import { orderStorageKey } from "@/components/buy-now";
import { OwnedCourse } from "@/components/owned-course";

export function CodeStep(props: {
  offer: string;
  /** The guest total the page showed (minor units), and its currency. */
  expectedTotalMinor: string;
  expectedCurrencyCode: string;
  /** The master-data country id that total was priced in (the code step needs one: this or the kit's visitorCountry). */
  country?: string | null;
  courseCode: string | null;
  /** The workspace's legal documents when it requires terms, with the page that shows them. */
  terms?: { documents: AcceptedDocument[]; url: string };
}) {
  const step = useCodeStep({
    offer: props.offer,
    expectedTotalMinor: props.expectedTotalMinor,
    expectedCurrencyCode: props.expectedCurrencyCode,
    country: props.country ?? null,
    storageKey: orderStorageKey,
    coursePath: typeof window === "undefined" ? null : window.location.pathname,
    ...(props.terms ? { terms: props.terms.documents } : {}),
  });
  const [email, setEmail] = useState(step.state.email);
  const { state, ids } = step;
  const error = state.error;

  // "I agree to the {terms links}." with the site's link where the placeholder is.
  const [termsBefore, termsAfter] = CODE_STEP_COPY.terms.split("{terms links}");
  const terms =
    props.terms && state.termsRequired ? (
      <p>
        <input {...step.termsInputProps} />{" "}
        <label htmlFor={ids.terms}>
          {termsBefore}
          <a href={props.terms.url}>terms</a>
          {termsAfter}
        </label>
        {error?.field === "terms" ? <span id={ids.termsError} hidden>{error.message}</span> : null}
      </p>
    ) : null;

  let body: ReactNode;
  if (state.step === "email" || state.step === "sending") {
    body = (
      <form onSubmit={(e) => { e.preventDefault(); void step.sendCode(email); }} noValidate>
        <label htmlFor={ids.email}>Email</label>
        <input {...step.emailInputProps} required value={email} onChange={(e) => setEmail(e.target.value)} />
        {error ? <p id={ids.emailError} role="alert">{error.message}</p> : null}
        <button type="submit" disabled={step.busy}>Send code</button>
      </form>
    );
  } else if (state.step === "owned") {
    body = <OwnedCourse courseCode={props.courseCode} message={state.settled ? "This course is yours now." : "You already have this course."} />;
  } else if (state.step === "confirm-price" || state.step === "pay-failed" || (state.step === "paying" && state.price)) {
    body = (
      <div>
        {step.priceLine ? <p>{step.priceLine}</p> : null}
        <button type="button" onClick={() => void step.pay()} disabled={step.busy} aria-describedby={error?.field === "payment" ? ids.paymentError : undefined}>
          {step.busy ? CODE_STEP_COPY.goingToPayment : (step.payLabel ?? CODE_STEP_COPY.verifyButton)}
        </button>
        {error?.field === "payment" ? <p id={ids.paymentError} role="alert">{error.message}</p> : null}
      </div>
    );
  } else if (state.step === "paying") {
    body = <p aria-hidden="true">{CODE_STEP_COPY.goingToPayment}</p>;
  } else {
    body = (
      <form onSubmit={(e) => { e.preventDefault(); void step.verify(); }}>
        <h2>{CODE_STEP_COPY.heading}</h2>
        <p>{fillCopy(CODE_STEP_COPY.intro, { email: state.email })}</p>
        <label htmlFor={ids.code}>{CODE_STEP_COPY.codeLabel}</label>
        {/* One input, no maxLength (a pasted "123 456" is stripped, then cut to six), no key handler: Tab leaves it. */}
        <input {...step.codeInputProps} />
        <p id={ids.codeHint}>{CODE_STEP_COPY.hint}</p>
        {error?.field === "code" ? <p id={ids.codeError} role="alert">{error.message}</p> : null}
        {terms}
        <button type="submit" disabled={step.busy}>{CODE_STEP_COPY.verifyButton}</button>
        <button type="button" onClick={() => void step.resend()} disabled={!step.canResend}>{step.resendLabel}</button>
        <button type="button" onClick={() => { setEmail(state.email); step.changeEmail(); }} disabled={step.busy}>{CODE_STEP_COPY.changeEmail}</button>
      </form>
    );
  }

  return (
    <section>
      {body}
      {/* The kit's polite live region: the countdown at its start and when ready, and "Taking you to payment…". */}
      <CodeStepLiveRegion step={step} />
    </section>
  );
}
