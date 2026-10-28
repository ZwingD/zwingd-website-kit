// Copy this file. Server code only: it holds the client secret.
import { configFromEnv, createMemberCheckout, createWebsiteKit, type MemberCheckout, type WebsiteKit } from "@zwingd-ce/website-kit-next";

let kit: WebsiteKit | null = null;
let checkout: MemberCheckout | null = null;

/**
 * The site's kit, made on first use so `next build` does not need the secret.
 * A missing or bad setting throws once, naming the setting, never its value.
 */
export function zwingd(): WebsiteKit {
  if (!kit) {
    kit = createWebsiteKit(
      configFromEnv(process.env, {
        insecureLocalCookies: process.env.ZWINGD_INSECURE_LOCAL_COOKIES === "true",
        // kit #11: the app's page for one course by code, if the workspace's app has one
        // (SCPMI: /communities/courses/:code). Without it, course links open /communities/learning.
        ...(process.env.ZWINGD_COURSE_PATH ? { coursePath: process.env.ZWINGD_COURSE_PATH } : {}),
        // The visitor's country for pricing, from the host's geo header; never the body. Used by the
        // code step's quote with the proof, and by member checkout (which inherits it).
        visitorCountry: (req) => countryIdFor(req.headers["x-vercel-ip-country"]),
      }),
    );
  }
  return kit;
}

/**
 * The visitor's country id for member pricing, from the host's geo header
 * (Vercel's `x-vercel-ip-country`) and the site's own map to master-data ids.
 * Null when either is missing: the member's profile country then decides.
 */
export function countryIdFor(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const map = JSON.parse(process.env.ZWINGD_COUNTRY_IDS || "{}") as Record<string, unknown>;
    const value = map[iso.toUpperCase()];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Member checkout (POST /session/checkout). The country comes from the kit's visitorCountry (the geo header), never the body. */
export function memberCheckout(): MemberCheckout {
  if (!checkout) {
    checkout = createMemberCheckout(zwingd());
  }
  return checkout;
}
