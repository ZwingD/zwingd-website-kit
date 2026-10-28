/**
 * startMemberCheckout: the browser half of member checkout (session hand-over
 * v1.1). The "Buy now" of a page whose visitor is signed in on the website:
 *
 *   const result = await startMemberCheckout(offer, {
 *     csrf,                               // the sign-out form's value, rendered by the server
 *     expectedTotalMinor: quote.totalMinor, // the member's price the page SHOWED (getMemberQuote)
 *     paymentGateway: quote.gateways[0]?.paymentGateway,
 *     storageKey: (orderId) => `mysite:checkout:order:${orderId}`, // what the return page reads
 *   });
 *   if (result.kind === "fallback") openGuestCheckout(result);
 *
 * It posts to the site's own `/session/checkout` (same origin; the server holds
 * the session token and the client secret). On a redirect it first keeps the
 * order token in sessionStorage under the site's key, in the record the website
 * checkout return page reads (`{ orderId, token, email, coursePath, expiresAt }`,
 * as scpmi-website's `StoredCheckout`), and only then sends the browser on. The
 * token never goes into an address, a cookie or a log.
 *
 * ⛔ No contact detail is stored: `email` is always "" (a member is signed in
 * and needs no "Log in with ..." hint; Helm on #1869), and `member: true` lets
 * a return page tell a member's order from a guest's.
 *
 * Never throws: every failure is a `fallback` answer.
 */
import type { CheckoutAttribution, MemberCheckoutAnswer } from "./checkout.ts";
import { CHECKOUT_ATTRIBUTION_KEYS, CHECKOUT_PATH } from "./checkout.ts";

/** The part of the Web Storage API the helper uses. */
export interface CheckoutStorage {
  setItem(key: string, value: string): void;
}

export interface StartMemberCheckoutOptions {
  /** The CSRF value the server rendered for this page (`kit.csrfFor` / `signOutFormToken`). */
  csrf: string;
  /** The member's total the page showed, unchanged (C2's `totalMinor`). */
  expectedTotalMinor: string;
  /** One of the quote's gateways. */
  paymentGateway?: string;
  couponCode?: string;
  attribution?: CheckoutAttribution;
  /** The site's sessionStorage key for an order, exactly as its return page reads it. */
  storageKey: (orderId: string) => string;
  /** The course page the buyer started on, for "Try again". */
  coursePath?: string | null;
  /** Default `/session/checkout`. */
  endpoint?: string;
  /** For tests and other runtimes. Defaults: the global `fetch`, `sessionStorage`, `location.assign`. */
  fetch?: typeof fetch;
  storage?: CheckoutStorage | null;
  navigate?: (url: string) => void;
}

export type StartMemberCheckoutResult = MemberCheckoutAnswer | { kind: "fallback"; reason: "storage-unavailable" };

/** What the return page reads back. */
export interface StoredMemberCheckout {
  orderId: string;
  token: string;
  /** Always "": the kit never stores a contact detail. Kept for the record's shape. */
  email: "";
  /** A member's order (the return page may skip the guest's sign-in hint). */
  member: true;
  coursePath: string | null;
  expiresAt: string | null;
}

/**
 * v0.2.0: what the return page reads back for a verified buyer's order (the
 * code step): the same shape, with `member: false` (no session; the return
 * page shows the thank-you button from `checkoutContinueFor`).
 */
export type StoredVerifiedCheckout = Omit<StoredMemberCheckout, "member"> & { member: false };

/**
 * Keep an order's token in this tab's storage under the site's key, before the
 * browser leaves for payment. False when it cannot be kept (no storage, a
 * full or blocked one): then do not send the buyer on.
 */
export function storeCheckoutOrder(
  order: { orderId: string; orderToken: string | null; orderTokenExpiresAt: string | null },
  options: { storageKey: (orderId: string) => string; coursePath?: string | null; storage?: CheckoutStorage | null; member: boolean },
): boolean {
  if (!order.orderToken) return false;
  const base = { orderId: order.orderId, token: order.orderToken, email: "" as const, coursePath: options.coursePath ?? null, expiresAt: order.orderTokenExpiresAt };
  const record: StoredMemberCheckout | StoredVerifiedCheckout = options.member ? { ...base, member: true } : { ...base, member: false };
  try {
    const storage = options.storage === undefined ? defaultStorage() : options.storage;
    if (!storage) return false;
    storage.setItem(options.storageKey(order.orderId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

const unavailable = (): StartMemberCheckoutResult => ({ kind: "fallback", reason: "unavailable" });

function defaultStorage(): CheckoutStorage | null {
  try {
    return (globalThis as { sessionStorage?: CheckoutStorage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isAnswer(value: unknown): value is MemberCheckoutAnswer {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "redirect") {
    const v = value as Record<string, unknown>;
    return typeof v.url === "string" && /^https?:\/\//.test(v.url) && typeof v.orderId === "string";
  }
  return kind === "already-owned" || (kind === "fallback" && typeof (value as { reason?: unknown }).reason === "string");
}

export async function startMemberCheckout(offer: string, options: StartMemberCheckoutOptions): Promise<StartMemberCheckoutResult> {
  const body = new URLSearchParams({ csrf: options.csrf, offer, expectedTotalMinor: options.expectedTotalMinor });
  if (options.paymentGateway) body.set("paymentGateway", options.paymentGateway);
  if (options.couponCode) body.set("couponCode", options.couponCode);
  for (const key of CHECKOUT_ATTRIBUTION_KEYS) {
    const value = options.attribution?.[key];
    if (typeof value === "string" && value !== "") body.set(key, value);
  }

  let answer: unknown;
  try {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const res = await fetchImpl(options.endpoint ?? CHECKOUT_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    });
    if (res.status !== 200) return unavailable();
    answer = await res.json();
  } catch {
    return unavailable();
  }
  if (!isAnswer(answer)) return unavailable();
  if (answer.kind !== "redirect") return answer;

  // kit #5: a settled order is the member's now. Whatever happens to its token,
  // the answer is `already-owned`, never a fallback that would offer guest
  // checkout to an owner. (The API answers a token for every start; none means
  // a misconfigured API, which it reports itself.)
  const owned = (): StartMemberCheckoutResult => ({ kind: "already-owned", settled: true });
  // The return page needs the order token: without it stored, the buyer is not sent on.
  const kept = storeCheckoutOrder(answer, {
    storageKey: options.storageKey,
    coursePath: options.coursePath ?? null,
    member: true,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  });
  if (!kept) return answer.settled === true ? owned() : { kind: "fallback", reason: "storage-unavailable" };

  const navigate = options.navigate ?? ((url: string) => (globalThis as { location?: { assign(u: string): void } }).location?.assign(url));
  navigate(answer.url);
  return answer;
}
