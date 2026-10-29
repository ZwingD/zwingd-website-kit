// A course page with member checkout. The SERVER asks the member's own price
// (getMemberQuote), so the page shows exactly what "Buy now" charges; a
// visitor who is not signed in gets the site's own guest checkout instead.
import { headers } from "next/headers";

import { getMemberQuote, signOutToken } from "@zwingd-ce/website-kit-next/server";

import { BuyNow } from "@/components/buy-now";
import { CodeStep } from "@/components/code-step";
import { OwnedCourse } from "@/components/owned-course";
import { countryIdFor, memberCheckout, zwingd } from "@/lib/zwingd";

export const dynamic = "force-dynamic";

function price(minor: string, exponent: number, currency: string): string {
  const major = Number(minor) / 10 ** exponent;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(major);
}

export default async function CoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ offer: string }>;
  searchParams: Promise<{ course?: string }>;
}) {
  const { offer } = await params;
  // The site knows which course each of its pages sells; the example takes it from ?course=.
  const { course } = await searchParams;
  const courseCode = typeof course === "string" ? course : null;
  const country = countryIdFor((await headers()).get("x-vercel-ip-country"));
  const [quoted, csrf] = await Promise.all([getMemberQuote(memberCheckout(), offer, { visitorCountry: country }), signOutToken(zwingd())]);

  if (quoted.status !== "ok" || !csrf) {
    const guest = guestTotal();
    return (
      <section>
        <h1>Course</h1>
        <p>Log in to buy as a member, or use the guest checkout.</p>
        {/* Checkout v3.2: a workspace with verifyEmail "before-payment" has the buyer prove their email first (no account, no session). */}
        {/* Only with a known guest total: a guessed one would show every buyer a false "member price" after the code. */}
        {process.env.EXAMPLE_VERIFY_EMAIL === "before-payment" && guest ? (
          <CodeStep offer={offer} expectedTotalMinor={guest.totalMinor} expectedCurrencyCode={guest.currencyCode} country={country} courseCode={courseCode} />
        ) : (
          <GuestCheckoutStandIn />
        )}
      </section>
    );
  }
  const { quote } = quoted;
  return (
    <section>
      <h1>Course</h1>
      <p>Your price: {price(quote.totalMinor, quote.minorUnitExponent, quote.currencyCode)}</p>
      {quote.alreadyEnrolled ? (
        <OwnedCourse courseCode={courseCode} message="You already have this course." />
      ) : (
        <BuyNow
          offer={offer}
          csrf={csrf}
          expectedTotalMinor={quote.totalMinor}
          paymentGateway={quote.gateways[0]?.paymentGateway}
          courseCode={courseCode}
        />
      )}
    </section>
  );
}

/**
 * The guest price the page shows, or null when it is not known. A real site reads it from the public guest quote
 * (in the country it priced in); the example takes it from its env.
 */
function guestTotal(): { totalMinor: string; currencyCode: string } | null {
  const totalMinor = process.env.EXAMPLE_GUEST_TOTAL_MINOR ?? "";
  const currencyCode = process.env.EXAMPLE_GUEST_CURRENCY ?? "USD";
  return /^\d{1,18}$/.test(totalMinor) && /^[A-Z]{3}$/.test(currencyCode) ? { totalMinor, currencyCode } : null;
}

/** Stands in for the website's guest checkout pop-up (#1866): not part of the kit. */
function GuestCheckoutStandIn() {
  return <p>[guest checkout pop-up]</p>;
}
