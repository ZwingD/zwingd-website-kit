"use client";
// Where the buyer comes back after paying: <origin>/checkout/return/<orderId>.
// A real site confirms the payment here with the stored order token
// (confirmHostedCheckoutPayment and myOrder, #1866); this example only shows
// that the token was kept for this order in this tab, never in the address.
import { useEffect, useState } from "react";

import { orderStorageKey } from "@/components/buy-now";

/**
 * `continueLabel` / `continueHref` come from the server page: the label only,
 * never the new-account flag, and the same href and analytics event for both.
 */
export function CheckoutReturn({ orderId, continueLabel, continueHref }: { orderId: string; continueLabel: string; continueHref: string }) {
  const [found, setFound] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(orderStorageKey(orderId));
      const record = raw ? (JSON.parse(raw) as { orderId?: unknown; token?: unknown }) : null;
      setFound(record?.orderId === orderId && typeof record.token === "string");
    } catch {
      setFound(false);
    }
  }, [orderId]);

  if (found === null) return <p>Checking your order…</p>;
  return found ? (
    <section>
      <h1>Thank you</h1>
      <p>Your order {orderId} is on its way. This page would now confirm the payment with the stored order token.</p>
      <a href={continueHref}>{continueLabel}</a>
    </section>
  ) : (
    <section>
      <h1>We can&apos;t show this order here</h1>
      <p>Open this page in the browser you paid in.</p>
    </section>
  );
}
