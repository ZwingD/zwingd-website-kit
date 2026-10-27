// A course page with member checkout. The SERVER asks the member's own price
// (getMemberQuote), so the page shows exactly what "Buy now" charges; a
// visitor who is not signed in gets the site's own guest checkout instead.
import { headers } from "next/headers";

import { getMemberQuote, signOutToken } from "@zwingd-ce/website-kit-next/server";

import { BuyNow } from "@/components/buy-now";
import { countryIdFor, memberCheckout, zwingd } from "@/lib/zwingd";

export const dynamic = "force-dynamic";

function price(minor: string, exponent: number, currency: string): string {
  const major = Number(minor) / 10 ** exponent;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(major);
}

export default async function CoursePage({ params }: { params: Promise<{ offer: string }> }) {
  const { offer } = await params;
  const country = countryIdFor((await headers()).get("x-vercel-ip-country"));
  const [quoted, csrf] = await Promise.all([getMemberQuote(memberCheckout(), offer, { visitorCountry: country }), signOutToken(zwingd())]);

  if (quoted.status !== "ok" || !csrf) {
    return (
      <section>
        <h1>Course</h1>
        <p>Log in to buy as a member, or use the guest checkout.</p>
        <GuestCheckoutStandIn />
      </section>
    );
  }
  const { quote } = quoted;
  return (
    <section>
      <h1>Course</h1>
      <p>Your price: {price(quote.totalMinor, quote.minorUnitExponent, quote.currencyCode)}</p>
      {quote.alreadyEnrolled ? (
        <p>You already have this course.</p>
      ) : (
        <BuyNow offer={offer} csrf={csrf} expectedTotalMinor={quote.totalMinor} paymentGateway={quote.gateways[0]?.paymentGateway} />
      )}
    </section>
  );
}

/** Stands in for the website's guest checkout pop-up (#1866): not part of the kit. */
function GuestCheckoutStandIn() {
  return <p>[guest checkout pop-up]</p>;
}
