// Where the buyer comes back after paying: <origin>/checkout/return/<orderId>.
// The SERVER reads the kit's HttpOnly new-account cookie (checkout v3.1) and
// hands the page only a label: "Continue sign-up" for a buyer whose account the
// code step made, else "Go to my course". Both open the app through
// /session/app (appLinkHref), which signs the buyer in to the app when
// ZWINGD_APP_SIGN_IN is on.
import { appLinkHref } from "@zwingd-ce/website-kit-next";
import { isNewAccountBuyer } from "@zwingd-ce/website-kit-next/server";

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
  const label = (await isNewAccountBuyer(zwingd())) ? "Continue sign-up" : "Go to my course";
  const to = typeof course === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(course) ? `/communities/courses/${course}` : "/communities/learning";
  return <CheckoutReturn orderId={orderId} continueLabel={label} continueHref={appLinkHref(to)} />;
}
