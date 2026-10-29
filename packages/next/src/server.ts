/**
 * Server-only helpers (Server Components, route handlers, Server Actions).
 * Never import this file from a Client Component: it reads the HttpOnly
 * session cookie through `next/headers`.
 *
 *   const member = await getMember(kit);          // { firstName?, lastName? } or null
 *   const signOut = await signOutToken(kit);      // the sign-out form's csrf value
 *   const account = await accountUrl(kit);        // where "Go to my account" opens
 *   const next = await getCheckoutContinue(kit);  // v0.2.0 thank-you button, or null
 */
import { cookies } from "next/headers";

import type { CheckoutContinue, MemberCheck, MemberCheckout, MemberContact, MemberQuoteCheck, WebsiteKit } from "@zwingd-ce/website-kit";

/** What a page may show: the member's name only. Never an email or phone (see `getCheckoutMember`). */
export interface SiteMember {
  firstName?: string;
  lastName?: string;
}

async function cookieMap(): Promise<Record<string, string>> {
  const store = await cookies();
  const out: Record<string, string> = {};
  for (const cookie of store.getAll()) out[cookie.name] = cookie.value;
  return out;
}

// SHORTCUT: a Server Component cannot set cookies, so when the API answers
// `active: false` the stale session cookie stays until the member's next
// /session/* call (client mode's /session/me clears it) or its own expiry, and each render checks again. Ceiling:
// one session check per render for such a browser. Upgrade trigger: session
// call volume (rate_limited) from a site with many signed-out-but-cookied
// visitors; then clear it from middleware.
function summaryOf(check: MemberCheck): SiteMember | null {
  if (check.status !== "signed-in") return null;
  const m = check.member;
  return { ...(m?.firstName ? { firstName: m.firstName } : {}), ...(m?.lastName ? { lastName: m.lastName } : {}) };
}

/**
 * Who is signed in, for the header: `{ firstName?, lastName? }`, or null when
 * nobody is. Cached up to 60 s; a 429, 503 or timeout keeps the member signed
 * in. Never starts a hand-over and never calls the app.
 */
export async function getMember(kit: WebsiteKit): Promise<SiteMember | null> {
  return summaryOf(await kit.getMember(await cookieMap()));
}

/**
 * The member for a server-rendered checkout prefill: always a fresh check,
 * with contact details only when that check succeeded. Null when nobody is
 * signed in or the check is not fresh (show the name only, or nothing).
 */
export async function getCheckoutMember(kit: WebsiteKit): Promise<(SiteMember & MemberContact) | null> {
  const check = await kit.freshMember(await cookieMap());
  if (check.status !== "signed-in" || !check.fresh) return null;
  return { ...summaryOf(check), ...(check.contact ?? {}) };
}

/**
 * The value the sign-out form posts as `csrf`, from the cookie set at sign-in.
 * Null when the browser has none (the form then cannot sign out; signing in
 * again sets it).
 */
export async function signOutToken(kit: WebsiteKit): Promise<string | null> {
  const value = (await cookieMap())[kit.cookieNames.csrf];
  return typeof value === "string" && value.length >= 32 ? value : null;
}

/**
 * Member checkout: the signed-in member's own quote for one offer, so the page
 * shows the price a start charges (`startMemberCheckout` echoes `totalMinor`).
 * `ended` means the API said the session is over.
 */
export async function getMemberQuote(
  checkout: MemberCheckout,
  offer: string,
  options: { visitorCountry?: string | null; couponCode?: string } = {}
): Promise<MemberQuoteCheck> {
  return checkout.getMemberQuote(await cookieMap(), offer, options);
}

/**
 * kit #11: where "Go to my account" opens: the kit's `accountPath`, else the
 * workspace's own landing path (read publicly, cached about 5 minutes), else
 * the app's home. Never throws.
 */
export async function accountUrl(kit: WebsiteKit): Promise<string> {
  return kit.accountUrl();
}

/**
 * v0.2.0, the thank-you page (checkout v3.2 §8 step 4): which button to show,
 * from a SERVER-side read of the proof context (`checkout-proof/context`):
 * `{ label: "Continue sign-up" | "Go to my course", action, continueAs, signInUrl }`,
 * or null when this browser holds no proof that is still good, or the context
 * read fails (an API fault): show your usual link to the course instead. Pass it to `<CheckoutContinueButton next={...} />`.
 * It never mints the continue nonce: only the press does (A3).
 */
export async function getCheckoutContinue(kit: WebsiteKit): Promise<CheckoutContinue | null> {
  return kit.checkoutContinueFor(await cookieMap());
}
