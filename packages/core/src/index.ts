/**
 * @zwingd-ce/website-kit - the framework-free core of the Zwingd website kit:
 * a workspace's own website recognises a member signed in to the workspace's
 * app (session hand-over v1). No runtime dependency: Web Crypto and `fetch`
 * only, so it runs on Node 18.17+ and edge runtimes.
 *
 * Most sites use an adapter (`@zwingd-ce/website-kit-node`,
 * `@zwingd-ce/website-kit-next`); this package is what they translate.
 */
export { createWebsiteKit, CSRF_FIELD, SESSION_PATHS } from "./flows.ts";
export type { RequestView, ResponseView, SessionMe, WebsiteKit } from "./flows.ts";
export { configFromEnv, resolveConfig, WebsiteKitConfigError, DEFAULT_TIMEOUT_MS } from "./config.ts";
export type { WebsiteKitConfig, WebsiteKitConfigInput } from "./config.ts";
export { savedPath, SAVED_PATH_MAX } from "./saved-path.ts";
export { cookieNames, parseCookieHeader, LOCAL_COOKIE_NAMES, SECURE_COOKIE_NAMES } from "./cookies.ts";
export type { CookieNames } from "./cookies.ts";
export { CHECK_CACHE_MS } from "./member.ts";
export type { MemberCheck, MemberContact, MemberSummary } from "./member.ts";
export type { HandoverMember } from "./api-client.ts";
// Member checkout (session hand-over v1.1).
export {
  CHECKOUT_ATTRIBUTION_KEYS,
  CHECKOUT_PATH,
  CHECKOUT_QUOTE_TIMEOUT_MS,
  CHECKOUT_RETURN_PATH,
  CHECKOUT_START_TIMEOUT_MS,
  createMemberCheckout,
} from "./checkout.ts";
export type {
  CheckoutAttribution,
  CheckoutFallbackReason,
  CheckoutResponseView,
  MemberCheckout,
  MemberCheckoutAnswer,
  MemberCheckoutOptions,
  MemberQuote,
  MemberQuoteCheck,
  VisitorCountryResolver,
} from "./checkout.ts";
export { startMemberCheckout } from "./browser.ts";
export type { CheckoutStorage, StartMemberCheckoutOptions, StartMemberCheckoutResult, StoredMemberCheckout } from "./browser.ts";
