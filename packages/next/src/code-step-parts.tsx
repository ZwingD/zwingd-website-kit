"use client";
/**
 * The two pieces of the v0.2.0 code step the kit draws itself (unstyled):
 *
 *   <CodeStepLiveRegion step={step} />
 *     The step's polite live region (§8 accessibility). Keep it mounted for the
 *     whole step. It says the countdown once when it starts and once when
 *     "Send a new code" is ready (never every second), and "Taking you to
 *     payment…" while going to payment. Visually hidden unless `visible`.
 *
 *   <CheckoutContinueButton next={await getCheckoutContinue(kit)} />
 *     The thank-you button (§8 step 4, A3): "Continue sign-up" or "Go to my
 *     course", picked on the server. It is a same-site form POST to the kit's
 *     /session/checkout-continue, which mints the continue nonce at the press
 *     (never on a page load) and answers the form that POSTs it to the app.
 */
import { useEffect, useState, type CSSProperties } from "react";

import type { CheckoutContinue } from "@zwingd-ce/website-kit";

import { createCodeStepClient, type CodeStep } from "./use-code-step.ts";

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export interface CodeStepLiveRegionProps {
  step: Pick<CodeStep, "announcement">;
  className?: string;
  /** Show the region's text on the page too. Default false (visually hidden, still announced). */
  visible?: boolean;
}

export function CodeStepLiveRegion({ step, className, visible = false }: CodeStepLiveRegionProps) {
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className={className} style={visible ? undefined : VISUALLY_HIDDEN}>
      {step.announcement}
    </p>
  );
}

export interface CheckoutContinueButtonProps {
  /** From `getCheckoutContinue(kit)` on the server. Null: nothing is drawn. */
  next: CheckoutContinue | null;
  className?: string;
  buttonClassName?: string;
  /** Where the kit's routes are mounted. Default `/session`. */
  basePath?: string;
  /** The `csrf` value, when the page already has it; else read from GET /session/code-step. */
  formToken?: string | null;
  /** For tests. */
  fetch?: typeof fetch;
}

export function CheckoutContinueButton({ next, className, buttonClassName, basePath, formToken, fetch: fetchImpl }: CheckoutContinueButtonProps) {
  const [csrf, setCsrf] = useState<string | null>(formToken ?? null);

  useEffect(() => {
    if (csrf || !next) return;
    let live = true;
    // The SameSite=Strict form value is not sent on the provider's cross-site return, so it is read here, same-origin.
    void createCodeStepClient({ ...(basePath ? { basePath } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) })
      .read()
      .then((read) => {
        if (live && read) setCsrf(read.formToken);
      });
    return () => {
      live = false;
    };
  }, [csrf, next, basePath, fetchImpl]);

  if (!next) return null;
  const base = (basePath ?? "/session").replace(/\/+$/, "");
  const action = basePath ? `${base}${next.action.slice("/session".length)}` : next.action;
  return (
    <form method="post" action={action} className={className}>
      <input type="hidden" name="csrf" value={csrf ?? ""} />
      <button type="submit" className={buttonClassName} disabled={!csrf} aria-disabled={!csrf}>
        {next.label}
      </button>
    </form>
  );
}
