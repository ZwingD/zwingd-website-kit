/**
 * The ONE same-site POST rule of the kit, behind POST /session/end (sign-out)
 * and POST /session/checkout (member checkout): session hand-over v1,
 * "POST /session/end", step 2.
 *
 *   - no cross-site `Origin` (absent is allowed: an older browser);
 *   - no `Sec-Fetch-Site` other than `same-origin` (absent is allowed);
 *   - AND the `SameSite=Strict` CSRF cookie's value sent in the form as `csrf`.
 */
import type { RequestView } from "./flows.ts";

/** The form field the CSRF value is posted in. */
export const CSRF_FIELD = "csrf";
/** What a CSRF value looks like (the kit writes 43 base64url characters). */
export const CSRF_VALUE = /^[A-Za-z0-9\-._~]{32,128}$/;

/** Header lookup that tolerates any casing an adapter hands in. */
export function header(req: RequestView, name: string): string | undefined {
  const direct = req.headers[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(req.headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : req.headers[key];
}

export function sameSitePost(req: RequestView, rule: { origin: string; csrfCookie: string }): boolean {
  const origin = header(req, "origin");
  if (origin !== undefined && origin !== rule.origin) return false;
  const site = header(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  const cookie = req.cookies[rule.csrfCookie];
  const sent = req.form?.[CSRF_FIELD];
  return typeof cookie === "string" && CSRF_VALUE.test(cookie) && sent === cookie;
}
