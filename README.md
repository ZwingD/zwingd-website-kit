# Zwingd website kit

The kit lets a workspace's own website recognise a member who is signed in to the workspace's Zwingd app. The website shows "My account" instead of "Log in" and never shows a sign-in form of its own.

It implements [session hand-over v1](https://github.com/ZwingD/zwingd-backend/blob/develop/docs/storefront-api/session-handover-v1.md). That document is the contract, and this kit follows it rule for rule.

| Package | For |
|---|---|
| `@zwingd-ce/website-kit` | The core. No framework and no runtime dependency (Web Crypto and `fetch`). Node 18.17+ and edge runtimes |
| `@zwingd-ce/website-kit-node` | Express and plain Node `http` servers |
| `@zwingd-ce/website-kit-next` | Next.js App Router, Next 15 and 16 |

## Next.js (App Router)

`examples/next-site` is a working site. Copy these four pieces into yours:

1. **`lib/zwingd.ts`**: makes the kit from the server environment, on first use, so `next build` never needs the secret.
2. **`app/session/[action]/route.ts`**: serves `/session/start`, `/session/callback`, `/session/end` and `/session/me`.
   ```ts
   import { createSessionRoutes } from "@zwingd-ce/website-kit-next";
   import { zwingd } from "@/lib/zwingd";
   export const dynamic = "force-dynamic";
   export function GET(request: Request) { return createSessionRoutes(zwingd()).GET(request); }
   export function POST(request: Request) { return createSessionRoutes(zwingd()).POST(request); }
   ```
3. **The header** (`app/layout.tsx`): the server reads the member, by name only, and the button shows "Log in" or "My account".
   ```tsx
   import { AccountButton, MemberProvider } from "@zwingd-ce/website-kit-next/client";
   import { getMember, signOutToken } from "@zwingd-ce/website-kit-next/server";
   const kit = zwingd();
   const [member, csrf] = await Promise.all([getMember(kit), signOutToken(kit)]);
   <MemberProvider member={member} signOutToken={csrf} appUrl={kit.config.appUrl}>
     <header>… <AccountButton className="…" menuClassName="…" itemClassName="…" /></header>
   </MemberProvider>
   ```
   `AccountButton` is unstyled. Give it your own labels (`labels={{ logIn: "Sign in" }}`) and a class on every part it draws: `className` (the root), `loadingClassName` (the placeholder), `logInClassName` (the "Log in" link), `triggerClassName` ("My account"), `menuClassName`, `itemClassName` (each menu item), `signOutFormClassName` and `signOutClassName` (the sign-out form and its button). A part with no class of its own uses `className`, or `itemClassName` for the sign-out button.

   **Cached or static pages:** use client mode instead. The browser reads `GET /session/me` once when the page loads, and the server-side read stays out of the page:
   ```tsx
   <MemberProvider mode="client" appUrl={process.env.ZWINGD_APP_URL!}>
     <header>… <AccountButton className="…" /></header>
   </MemberProvider>
   ```
   Until the answer arrives, `useMember()` is null and `AccountButton` renders an empty element with your class, so a member never sees "Log in" flash. The read gives up after about 5 seconds and shows "Log in", so a slow API never leaves the header empty; it asks again only when the visitor next focuses or clicks the button, never on a timer. `/session/me` answers `{ member: { firstName?, lastName? } | null, signOutToken }` with `Cache-Control: no-store`. It refuses cross-site reads, goes through the 60-second check cache, and clears the session cookie when the session has ended.
4. **`.env.example`**: the five server settings. Never prefix them `NEXT_PUBLIC_`.

**Rules the kit already keeps for you:**
- A plain page view never contacts the app. Only a click on "Log in" starts a hand-over.
- `getMember` returns the name only.
- For a checkout prefill, use `getCheckoutMember`. It makes a fresh check and returns an email or phone only when that check succeeded.
- A member's Buy Now goes straight to payment through member checkout (below). A visitor who is not signed in keeps your guest checkout.

**Member checkout** (session hand-over v1.1): a member signed in on your website buys with one click, no pop-up and no email to type.
1. In `lib/zwingd.ts`, make one `createMemberCheckout(zwingd(), { visitorCountry })`. `visitorCountry(request)` returns the visitor's master-data country id from your host's geo header (the example maps `x-vercel-ip-country` through `ZWINGD_COUNTRY_IDS`), or null. The country never comes from the request body.
2. Pass it to the routes: `createSessionRoutes(zwingd(), { checkout: memberCheckout() })`. They then also serve `POST /session/checkout`.
3. On the course page (a Server Component), read the member's own price with `getMemberQuote(memberCheckout(), offer, { visitorCountry })` and show its `totalMinor`. That is the price a start charges.
4. The Buy Now button (a Client Component) calls `startMemberCheckout(offer, { csrf, expectedTotalMinor: quote.totalMinor, paymentGateway: quote.gateways[0]?.paymentGateway, storageKey })`. `csrf` is the sign-out value (`signOutToken(kit)`, or `/session/me`'s `signOutToken`); `storageKey(orderId)` is the sessionStorage key your return page reads.
   - `redirect`: the order token is stored (`{ orderId, token, email: "", coursePath, expiresAt, member: true }`) and the browser goes to payment, then back to `<origin>/checkout/return/<orderId>`. The return address is always that page, never one from the browser.
   - `already-owned`: show "You already have this course".
   - `fallback`: use your guest checkout. `reason` says why: `signed-out`, `not-available` (an API without member checkout), `checkout-disabled`, `price-changed` (with the new `quote` to show; nothing is started at a price the page did not show), `refused`, `unavailable` or `storage-unavailable`.

`examples/next-site` has it all: `app/courses/[offer]/page.tsx`, `components/buy-now.tsx` and `app/checkout/return/[orderId]/page.tsx`.

**Local development:**
1. Set `ZWINGD_INSECURE_LOCAL_COOKIES=true` and `ZWINGD_SITE_ORIGIN=http://localhost:3100`.
2. Have the platform team list that origin for the dev workspace.
3. Run `pnpm --filter next-site dev`.

## Before you start

The platform team lists your website's origin for the workspace and gives you a client secret. Your **server** environment then holds:

| Name | Value |
|---|---|
| `ZWINGD_API_URL` | The API address |
| `ZWINGD_APP_URL` | The workspace's app address, exactly as given |
| `ZWINGD_REALM` | The workspace's realm |
| `ZWINGD_SESSION_CLIENT_SECRET` | The client secret for this website's origin |
| `ZWINGD_SITE_ORIGIN` | This website's origin, exactly as listed, for example `https://www.example.org` |

None of these may reach the browser.

## Express

```ts
import express from "express";
import { configFromEnv, createSessionHandler, createWebsiteKit, getMember, signOutFormToken } from "@zwingd-ce/website-kit-node";

const kit = createWebsiteKit(configFromEnv(process.env));
const app = express();

// Serves GET /session/start, GET /session/callback, POST /session/end and GET /session/me,
// and with { checkout: createMemberCheckout(kit, { visitorCountry }) } also POST /session/checkout.
app.use(createSessionHandler(kit));

app.get("/", async (req, res) => {
  const check = await getMember(kit, req, res); // clears the cookie when the session is over
  if (check.status === "signed-in") {
    const csrf = signOutFormToken(kit, req, res);
    // "My account" plus a sign-out form:
    // <form method="post" action="/session/end"><input type="hidden" name="csrf" value="${csrf}"><button>Sign out</button></form>
  } else {
    // "Log in" links to /session/start?next=/
  }
});
```

## What the kit does for you

- **Start:** `/session/start` always asks the app with `prompt=login`. The kit never runs a silent check.
- **Callback:** the code is exchanged exactly once, and a failed exchange is never retried.
- **Saved path:** the `next` path is checked against the contract's saved-path rule and its fixtures. Anything that is not a same-origin path becomes `/`.
- **Cookies:** all three are `__Host-`, `HttpOnly` and `Secure`. Each removal also carries `Secure; Path=/`.
- **Who is signed in, in the browser:** `/session/me` answers the name and the sign-out form value only, to same-origin requests only.
- **Sign-out and member checkout:** `/session/end` and `/session/checkout` accept a same-site POST only, carrying the form's CSRF value: one rule for both (`sameSitePost`). Its cookies are cleared whatever the API answers, and the member is sent on to the app's sign-out.
- **Session checks:** a check is cached for 60 seconds. The session is dropped only on `active: false`, never on a 429, a 503 or a timeout. Contact details are answered only from a check under 60 seconds old. Use `freshMember` before you prefill a checkout.
- **Member checkout:** the server calls the API with the client secret and the session cookie's token (10 s for a quote, 30 s for a start). A start is never retried.
- **Secrets:** no token, secret, verifier or code is ever logged, thrown or put in a URL beyond the contract's own redirects. The order token goes only to the browser that paid, which keeps it in sessionStorage.

For local development against `http://localhost`, pass `insecureLocalCookies: true`. This uses unprefixed cookie names without `Secure`, and the kit refuses it when `NODE_ENV=production`.

## Development

```sh
pnpm install
pnpm -r type-check && pnpm -r test && pnpm -r build
```

Releases: first run `pnpm -r test` with a `zwingd-backend` checkout beside this repo, so the saved-path fixtures test compares against the contract (CI cannot read the private repo and skips it). Then push a tag `vX.Y.Z`. The release workflow publishes every package after type-check, tests and build pass.
