/**
 * @zwingd-ce/website-kit - the framework-free core of the Zwingd website kit:
 * a workspace's own website recognises a member signed in to the workspace's
 * app (session hand-over v1). No runtime dependency: Web Crypto and `fetch`
 * only, so it runs on Node 18.17+ and edge runtimes.
 *
 * Most sites use an adapter (`@zwingd-ce/website-kit-node`,
 * `@zwingd-ce/website-kit-next`); this package is what they translate.
 */
export { createWebsiteKit, CSRF_FIELD, SESSION_PATHS, SIGN_OUT_NEXT_FIELD } from "./flows.ts";
export { courseUrlFor, LANDING_PATH_CACHE_MS, LEARNING_PATH } from "./account.ts";
export type { RequestView, ResponseView, SessionMe, WebsiteKit } from "./flows.ts";
export { configFromEnv, forwardedBuyerIp, resolveConfig, WebsiteKitConfigError, DEFAULT_TIMEOUT_MS } from "./config.ts";
export type { BuyerIpResolver, VisitorCountryResolver, WebsiteKitConfig, WebsiteKitConfigInput } from "./config.ts";
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
} from "./checkout.ts";
// Member events (B2 + B4: gateway events/read and events/register).
export { createMemberEvents, MEMBER_EVENT_READ_TIMEOUT_MS, MEMBER_EVENT_REGISTER_TIMEOUT_MS } from "./events.ts";
export type {
  MemberEvent,
  MemberEventCheck,
  MemberEventConsent,
  MemberEventForm,
  MemberEventQuestion,
  MemberEventReadRefusal,
  MemberEventRegisterRefusal,
  MemberEventRegisterResult,
  MemberEventRegistration,
  MemberEvents,
  MemberEventSeat,
  MemberEventsOptions,
} from "./events.ts";
export { startMemberCheckout } from "./browser.ts";
export { sameSitePost } from "./same-site.ts";
export type { CheckoutStorage, StartMemberCheckoutOptions, StartMemberCheckoutResult, StoredMemberCheckout } from "./browser.ts";
// Checkout v3.2: the code step before payment and the thank-you continue (v0.2.0).
export { CODE_PATHS } from "./code-routes.ts";
export type { CheckoutContinue, CheckoutContinueAnswer, CodeStepRead } from "./code-routes.ts";
export {
  CODE_STEP_COPY,
  codeStepAnnouncement,
  codeStepError,
  codeStepReducer,
  fillCopy,
  formatAmount,
  initialCodeStep,
  KIT_REASONS,
  normalizeCode,
  PROOF_GONE_REASONS,
  resendCountdown,
  UNAVAILABLE_REASON,
} from "./code-step.ts";
export type {
  CodeStepAction,
  CodeStepCopyKey,
  CodeStepError,
  CodeStepField,
  CodeStepName,
  CodeStepPayment,
  CodeStepPrice,
  CodeStepReason,
  CodeStepRefusal,
  CodeStepState,
  CodeStepTicket,
  HeldCodeStep,
  KitReason,
  PendingCodeStep,
} from "./code-step.ts";
export { APP_CONTINUE_PATH, CODE_CALL_TIMEOUT_MS, CODE_REASONS } from "./api-client.ts";
export type { AcceptedDocument, CodeReason, ContinueAs } from "./api-client.ts";
export { readCheckoutOrder, storeCheckoutOrder } from "./browser.ts";
export type { StoredCheckout, StoredVerifiedCheckout } from "./browser.ts";
