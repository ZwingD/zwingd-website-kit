"use client";
// Where the buyer comes back after paying: <origin>/checkout/return/<orderId>.
// A real site confirms the payment here with the stored order token
// (confirmHostedCheckoutPayment and myOrder, #1866); this example only shows
// that the token was kept for this order in this tab, never in the address.
import { useEffect, useState } from "react";

import { CheckoutContinueButton, CODE_STEP_COPY, readCheckoutOrder, type CheckoutContinue } from "@zwingd-ce/website-kit-next/client";

import { orderStorageKey } from "@/components/buy-now";

/**
 * `next` comes from the server page (getCheckoutContinue): the button's label
 * and where it posts, never the proof. Null: no code-step proof in this
 * browser, so the usual course link.
 */
export function CheckoutReturn({ orderId, next, courseHref }: { orderId: string; next: CheckoutContinue | null; courseHref: string }) {
  const [found, setFound] = useState<boolean | null>(null);

  useEffect(() => {
    setFound(readCheckoutOrder(orderId, { storageKey: orderStorageKey }) !== null);
  }, [orderId]);

  if (found === null) return <p>Checking your order…</p>;
  return found ? (
    <section>
      <h1>Thank you</h1>
      <p>Your order {orderId} is on its way. This page would now confirm the payment with the stored order token.</p>
      {next ? <CheckoutContinueButton next={next} /> : <a href={courseHref}>{CODE_STEP_COPY.goToCourse}</a>}
    </section>
  ) : (
    <section>
      <h1>We can&apos;t show this order here</h1>
      <p>Open this page in the browser you paid in.</p>
    </section>
  );
}
