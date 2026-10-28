/**
 * The website's cookies (session hand-over v1, "Cookies"):
 *   - start:   `state`, the PKCE verifier and the saved path; 10 minutes;
 *   - session: the session token; until `expiresAt`;
 *   - csrf:    the sign-out form's value, `SameSite=Strict`, set with the session;
 *   - return:  the page a sign-out started on, kept while the app signs the
 *              member out (the app always returns to `<origin>/`); 10 minutes;
 *   - new:     v0.2.0, `1` when the code verify made or completed the account
 *              (`isNewAccount`); the session's life; only the server reads it;
 *   - ticket:  v0.2.0, the open code step (ticket, email, offer, times), so a
 *              reload after the mail app resumes the step; 10 minutes.
 * All `__Host-` names, `HttpOnly`, `Secure`, `Path=/`. A removing `Set-Cookie`
 * carries `Secure` and `Path=/` too, or the browser ignores it and the cookie
 * stays. `insecureLocalCookies` (local `http://localhost` only) drops the
 * prefix and `Secure`.
 */

export interface CookieNames {
  start: string;
  session: string;
  csrf: string;
  return: string;
  newAccount: string;
  ticket: string;
}

export const SECURE_COOKIE_NAMES: CookieNames = Object.freeze({
  start: "__Host-zw_start",
  session: "__Host-zw_session",
  csrf: "__Host-zw_csrf",
  return: "__Host-zw_return",
  newAccount: "__Host-zw_new",
  ticket: "__Host-zw_ticket",
});

export const LOCAL_COOKIE_NAMES: CookieNames = Object.freeze({
  start: "zw_start",
  session: "zw_session",
  csrf: "zw_csrf",
  return: "zw_return",
  newAccount: "zw_new",
  ticket: "zw_ticket",
});

export const START_COOKIE_MAX_AGE_S = 600;
export const RETURN_COOKIE_MAX_AGE_S = 600;
export const TICKET_COOKIE_MAX_AGE_S = 600;

export function cookieNames(insecureLocalCookies: boolean): CookieNames {
  return insecureLocalCookies ? LOCAL_COOKIE_NAMES : SECURE_COOKIE_NAMES;
}

/** A `Cookie` request header as a map; a repeated name keeps its first value, as browsers send the most specific first. */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface CookieOptions {
  sameSite: "Lax" | "Strict";
  /** Seconds; 0 removes the cookie. */
  maxAge: number;
  expires?: Date;
}

/** One `Set-Cookie` value. `value` must already be cookie-safe (the kit only writes base64url and hex). */
export function serializeCookie(name: string, value: string, options: CookieOptions, insecureLocalCookies: boolean): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", `SameSite=${options.sameSite}`, `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`];
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (!insecureLocalCookies) parts.push("Secure");
  return parts.join("; ");
}

/** The `Set-Cookie` that removes a cookie: empty, expired, and still `Secure; Path=/`. */
export function clearCookie(name: string, sameSite: "Lax" | "Strict", insecureLocalCookies: boolean): string {
  return serializeCookie(name, "", { sameSite, maxAge: 0, expires: new Date(0) }, insecureLocalCookies);
}
