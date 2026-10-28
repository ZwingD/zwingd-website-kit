/**
 * The /session/* routes (start, callback, end, me; v0.2.0 the code step and the thank-you continue) as App Router route handlers, on the Web
 * `Request` / `Response` only, so they run on Node and edge alike:
 *
 *   // app/session/[action]/route.ts
 *   import { createSessionRoutes } from "@zwingd-ce/website-kit-next";
 *   import { kit } from "@/lib/zwingd";
 *   export const { GET, POST } = createSessionRoutes(kit);
 *   export const dynamic = "force-dynamic";
 *
 * With `{ checkout: createMemberCheckout(kit, ...) }` they also serve POST
 * /session/checkout (member checkout, session hand-over v1.1).
 */
import {
  CHECKOUT_PATH,
  parseCookieHeader,
  type MemberCheckout,
  type RequestView,
  type ResponseView,
  type WebsiteKit,
} from "@zwingd-ce/website-kit";

const FORM_LIMIT_BYTES = 8 * 1024;

/** The urlencoded body of a POST (the sign-out form), capped; anything else is an empty form. */
async function formOf(request: Request): Promise<Record<string, string>> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return {};
  const text = await request.text();
  if (text.length > FORM_LIMIT_BYTES) return {};
  return Object.fromEntries(new URLSearchParams(text));
}

/** The core's view of a Web request. */
export async function toRequestView(request: Request): Promise<RequestView> {
  const method = request.method.toUpperCase();
  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    method,
    url: request.url,
    cookies: parseCookieHeader(request.headers.get("cookie")),
    headers,
    ...(method === "POST" ? { form: await formOf(request) } : {}),
  };
}

/** A Web response from the core's view: status, headers, one Set-Cookie per cookie, the body if any. */
export function toResponse(view: ResponseView): Response {
  const headers = new Headers(view.headers);
  for (const line of view.setCookies) headers.append("Set-Cookie", line);
  return new Response(view.body ?? null, { status: view.status, headers });
}

export interface SessionRoutesOptions {
  /** Serve POST /session/checkout with this member checkout; without it the path answers 404. */
  checkout?: MemberCheckout;
}

/** `{ GET, POST }` for `app/session/[action]/route.ts`; any other /session/ path answers 404. */
export function createSessionRoutes(kit: WebsiteKit, options: SessionRoutesOptions = {}) {
  async function handler(request: Request): Promise<Response> {
    try {
      if (options.checkout && new URL(request.url).pathname === CHECKOUT_PATH) {
        return toResponse(await options.checkout.checkout(await toRequestView(request)));
      }
      const view = await kit.handle(await toRequestView(request));
      return view ? toResponse(view) : new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    } catch {
      // Never the error itself: a fixed, empty 500.
      return new Response(null, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  }
  return { GET: handler, POST: handler };
}

/**
 * kit #10, for `middleware.ts`: the app's sign-out always returns the browser to
 * `<origin>/`; this sends it on to the page the sign-out started from (kept by
 * POST /session/end under the saved-path rule) and drops the cookie. Undefined
 * for every other request, so the page is served as usual.
 *
 *   // middleware.ts
 *   import { signOutReturn } from "@zwingd-ce/website-kit-next";
 *   import { zwingd } from "@/lib/zwingd";
 *   export function middleware(request: Request) { return signOutReturn(zwingd(), request); }
 *   export const config = { matcher: "/" };
 */
export function signOutReturn(kit: WebsiteKit, request: Request): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const view = kit.signOutReturn({
    method: request.method.toUpperCase(),
    url: request.url,
    cookies: parseCookieHeader(request.headers.get("cookie")),
    headers: {},
  });
  if (!view) return undefined;
  const response = toResponse(view);
  // A proxy (middleware) must answer an ABSOLUTE Location: Next's adapter
  // parses it with `new NextURL(location)` and no base, so the kit's relative
  // saved path threw "Invalid URL" and the page answered 500. The saved path is
  // same-origin by the saved-path rule, so this keeps the request's own origin.
  const location = response.headers.get("location");
  if (location) response.headers.set("location", new URL(location, request.url).href);
  return response;
}
