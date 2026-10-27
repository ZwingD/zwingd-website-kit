"use client";
// The member's "Buy now": one click, no form. The order token is kept in this
// tab's sessionStorage under the site's key before the browser goes to payment.
import { useState } from "react";

import { startMemberCheckout } from "@zwingd-ce/website-kit-next/client";

import { OwnedCourse } from "./owned-course";

/** The site's own key: its return page reads the order back with it. */
export const orderStorageKey = (orderId: string) => `example:checkout:order:${orderId}`;

export function BuyNow(props: { offer: string; csrf: string; expectedTotalMinor: string; paymentGateway?: string; courseCode: string | null }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [owned, setOwned] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    // The status line always has text when it is drawn: never an empty live region.
    setNote("Taking you to payment…");
    const result = await startMemberCheckout(props.offer, {
      csrf: props.csrf,
      expectedTotalMinor: props.expectedTotalMinor,
      paymentGateway: props.paymentGateway,
      storageKey: orderStorageKey,
      coursePath: window.location.pathname,
    });
    if (result.kind === "redirect") return; // on its way to payment; the line keeps saying so
    setBusy(false);
    // Iris on #6: a zero-total order that settled just now reads as the buyer's new course.
    if (result.kind === "already-owned") {
      setNote(null);
      setOwned(result.settled ? "This course is yours now." : "You already have this course.");
    } else if (result.reason === "price-changed") setNote("The price has changed. Reload the page to see the new price.");
    else setNote("Member checkout isn't available right now. Use the guest checkout instead.");
  }

  if (owned) return <OwnedCourse courseCode={props.courseCode} message={owned} />;

  return (
    <div>
      <button type="button" onClick={buy} disabled={busy} aria-busy={busy}>
        {busy ? "Taking you to payment…" : "Buy now"}
      </button>
      {note ? <p role="status">{note}</p> : null}
    </div>
  );
}
