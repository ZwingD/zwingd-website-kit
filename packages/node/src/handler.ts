/**
 * The website kit on a plain Node `(req, res)` server, Express included.
 *
 *   app.use(createSessionHandler(kit));          // Express: serves /session/*, else next()
 *   http.createServer((req, res) => handler(req, res, () => { ...the site... }));
 *
 * A thin translation of the core's request and response views. The sign-out
 * POST body is read here (urlencoded, at most 8 kb) unless a body parser has
 * already put it on `req.body`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CHECKOUT_PATH,
  parseCookieHeader,
  type CheckoutResponseView,
  type MemberCheck,
  type MemberCheckout,
  type RequestView,
  type ResponseView,
  type WebsiteKit,
} from "@zwingd-ce/website-kit";

const FORM_LIMIT_BYTES = 8 * 1024;

type Next = (err?: unknown) => void;
type BodyCarrier = IncomingMessage & { body?: unknown };

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  return out;
}

/** The urlencoded body of a POST: an already-parsed `req.body` object, else read here (capped). */
async function formOf(req: BodyCarrier): Promise<Record<string, string>> {
  if (req.body && typeof req.body === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  }
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > FORM_LIMIT_BYTES) return {};
    chunks.push(chunk as Buffer);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/** The core's view of a Node request. `origin` resolves a relative `req.url`. */
export async function toRequestView(req: IncomingMessage, origin: string): Promise<RequestView> {
  const method = (req.method ?? "GET").toUpperCase();
  return {
    method,
    url: new URL(req.url ?? "/", origin).href,
    cookies: parseCookieHeader(req.headers.cookie),
    headers: headersOf(req),
    ...(method === "POST" ? { form: await formOf(req as BodyCarrier) } : {}),
  };
}

/** Write a core response view to a Node response. */
export function writeResponse(res: ServerResponse, view: ResponseView): void {
  res.statusCode = view.status;
  for (const [name, value] of Object.entries(view.headers)) res.setHeader(name, value);
  if (view.setCookies.length > 0) res.setHeader("Set-Cookie", view.setCookies);
  res.end(view.body);
}

/** Write the member checkout's JSON answer (a core view with a body). */
function writeCheckoutResponse(res: ServerResponse, view: CheckoutResponseView): void {
  res.statusCode = view.status;
  for (const [name, value] of Object.entries(view.headers)) res.setHeader(name, value);
  if (view.setCookies.length > 0) res.setHeader("Set-Cookie", view.setCookies);
  res.end(view.body);
}

const SESSION_PREFIX = "/session/";

export interface SessionHandlerOptions {
  /** Serve `POST /session/checkout` (member checkout) with this; without it the path is the site's. */
  checkout?: MemberCheckout;
}

/**
 * Serves `/session/start`, `/session/callback`, `/session/end` and `/session/me`; any other
 * path goes to `next` (Express), or answers 404 when there is none.
 */
export function createSessionHandler(kit: WebsiteKit, options: SessionHandlerOptions = {}) {
  return async function sessionHandler(req: IncomingMessage, res: ServerResponse, next?: Next): Promise<void> {
    const path = new URL(req.url ?? "/", kit.config.origin).pathname;
    if (!path.startsWith(SESSION_PREFIX)) {
      if (next) return next();
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      if (path === CHECKOUT_PATH && options.checkout) {
        return writeCheckoutResponse(res, await options.checkout.checkout(await toRequestView(req, kit.config.origin)));
      }
      const view = await kit.handle(await toRequestView(req, kit.config.origin));
      if (view) return writeResponse(res, view);
      if (next) return next();
      res.statusCode = 404;
      res.end();
    } catch {
      // Never the error itself: it could name a URL the kit built. A fixed, empty 500.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Cache-Control", "no-store");
      }
      res.end();
    }
  };
}

/**
 * Who is signed in, for a server-rendered page. When the API says the session
 * is over, the session cookie is cleared on `res` (pass it), so the browser
 * drops it too.
 */
export async function getMember(kit: WebsiteKit, req: IncomingMessage, res?: ServerResponse): Promise<MemberCheck> {
  const check = await kit.getMember(parseCookieHeader(req.headers.cookie));
  if (check.status === "ended" && res && !res.headersSent) appendSetCookie(res, kit.clearSessionCookie());
  return check;
}

/** The same, always asking the API first: use it before showing a checkout prefill. */
export async function freshMember(kit: WebsiteKit, req: IncomingMessage, res?: ServerResponse): Promise<MemberCheck> {
  const check = await kit.freshMember(parseCookieHeader(req.headers.cookie));
  if (check.status === "ended" && res && !res.headersSent) appendSetCookie(res, kit.clearSessionCookie());
  return check;
}

/**
 * The value a sign-out form posts as `csrf` (`<input type="hidden" name="csrf">`).
 * Sets a new CSRF cookie on `res` when the browser has none.
 */
export function signOutFormToken(kit: WebsiteKit, req: IncomingMessage, res: ServerResponse): string {
  const { token, setCookie } = kit.csrfFor(parseCookieHeader(req.headers.cookie));
  if (setCookie && !res.headersSent) appendSetCookie(res, setCookie);
  return token;
}

function appendSetCookie(res: ServerResponse, line: string): void {
  const existing = res.getHeader("Set-Cookie");
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  res.setHeader("Set-Cookie", [...list, line]);
}
