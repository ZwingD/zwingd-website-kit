// Where the buyer comes back after paying: <origin>/checkout/return/<orderId>.
// Checkout v3.2: for a buyer who proved their email in the code step, the
// SERVER reads the proof context (getCheckoutContinue) and hands the page only
// the button: "Continue sign-up" (new or pending) or "Go to my course"
// (member). The press is a form POST to /session/checkout-continue, which
// mints the one-time continue nonce then (never on this page load) and sends
// the buyer on to the app with a form POST. Without a proof (another browser,
// or it expired) the page shows the usual course link instead.
import { getCheckoutContinue } from "@zwingd-ce/website-kit-next/server";

import { CheckoutReturn } from "@/components/checkout-return";
import { zwingd } from "@/lib/zwingd";

export const dynamic = "force-dynamic";

export default async function CheckoutReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ course?: string }>;
}) {
  const { orderId } = await params;
  const { course } = await searchParams;
  const kit = zwingd();
  const next = await getCheckoutContinue(kit);
  const courseCode = typeof course === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(course) ? course : null;
  return <CheckoutReturn orderId={orderId} next={next} courseHref={kit.courseUrl(courseCode ?? "")} />;
}
