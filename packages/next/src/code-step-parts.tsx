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
 *     course", picked on the server. ONE press: it POSTs (same-site, with the
 *     form value) to the kit's /session/checkout-continue, which mints the 60 s
 *     continue nonce then (never on a page load); the button then submits a
 *     hidden form POST with the nonce to the app's /session/checkout-continue.
 *     The nonce lives only in that handler's local variable and the form's
 *     body: no state, no storage, no URL, no log. The app still asks
 *     "Continue as {email}" before signing in. Any failure opens the app's
 *     normal sign-in, including a form value that cannot be read.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { APP_CONTINUE_PATH, type CheckoutContinue } from "@zwingd-ce/website-kit";

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
  /** Where the kit's routes are mounted. Default `/session`. */
  basePath?: string;
  /** The `csrf` value, when the page already has it; else read from GET /session/code-step. */
  formToken?: string | null;
  /** For tests and other runtimes. Defaults: the global `fetch`, a real form submit, `location.assign`. */
  fetch?: typeof fetch;
  submit?: (form: HTMLFormElement) => void;
  navigate?: (url: string) => void;
}

const NONCE = /^[A-Za-z0-9_-]{16,512}$/;

/** The app's continue route only (A3, A4): https, exactly this path, no query or fragment. */
function continueUrlOk(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    return (url.protocol === "https:" || local) && !url.username && !url.password && !url.search && !url.hash && url.pathname === APP_CONTINUE_PATH;
  } catch {
    return false;
  }
}

export function CheckoutContinueButton({ next, className, basePath, formToken, fetch: fetchImpl, submit, navigate }: CheckoutContinueButtonProps) {
  const [csrf, setCsrf] = useState<string | null>(formToken ?? null);
  const [busy, setBusy] = useState(false);
  // The one-press guard: `busy` is a render's copy, so a second click before the re-render would mint a second nonce.
  const pressing = useRef(false);

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

  // Back from the app (U9a): a page restored from the back/forward cache may be pressed again.
  useEffect(() => {
    const again = () => {
      pressing.current = false;
      setBusy(false);
    };
    globalThis.addEventListener?.("pageshow", again);
    return () => globalThis.removeEventListener?.("pageshow", again);
  }, []);

  if (!next) return null;
  const base = (basePath ?? "/session").replace(/\/+$/, "");
  const endpoint = basePath ? `${base}${next.action.slice("/session".length)}` : next.action;
  const signInUrl = next.signInUrl;

  async function press() {
    if (pressing.current) return;
    pressing.current = true;
    setBusy(true);
    const go = navigate ?? ((url: string) => (globalThis as { location?: { assign(u: string): void } }).location?.assign(url));
    const read = () => createCodeStepClient({ ...(basePath ? { basePath } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) }).read();
    // The read on load failed: try once more now; without a form value the continue cannot be asked (E10).
    const token = csrf ?? (await read())?.formToken ?? null;
    if (!token) {
      go(signInUrl);
      return;
    }
    const ask = async (token: string): Promise<{ status: number; body: { nonce?: unknown; continueUrl?: unknown } | null }> => {
      try {
        const res = await (fetchImpl ?? globalThis.fetch)(endpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({ csrf: token }).toString(),
        });
        return { status: res.status, body: res.ok ? ((await res.json()) as { nonce?: unknown; continueUrl?: unknown }) : null };
      } catch {
        return { status: 0, body: null };
      }
    };
    let first = await ask(token);
    // 403: the form value went stale (another route dropped the cookie). The kit refused before any call, so ask
    // again ONCE with a fresh value.
    if (first.status === 403) {
      const fresh = await read();
      if (fresh && fresh.formToken !== token) {
        setCsrf(fresh.formToken);
        first = await ask(fresh.formToken);
      }
    }
    const answer = first.body;
    const nonce = answer?.nonce;
    const continueUrl = answer?.continueUrl;
    if (typeof nonce !== "string" || !NONCE.test(nonce) || !continueUrlOk(continueUrl)) {
      go(signInUrl);
      return;
    }
    // The nonce goes into this form's body only, and the form leaves with it.
    const form = document.createElement("form");
    form.method = "post";
    form.action = continueUrl;
    form.style.display = "none";
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "nonce";
    input.value = nonce;
    form.appendChild(input);
    document.body.appendChild(form);
    (
      submit ??
      ((f: HTMLFormElement) => {
        f.submit();
        // The submission is under way: the used nonce is not left in the page (e.g. one restored from the back/forward cache).
        f.remove();
      })
    )(form);
  }

  return (
    <button type="button" className={className} disabled={busy} aria-disabled={busy} aria-busy={busy} onClick={() => void press()}>
      {next.label}
    </button>
  );
}
