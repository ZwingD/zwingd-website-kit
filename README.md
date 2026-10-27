# Zwingd website kit

The kit is for a workspace's own website. It recognises a member who is signed in to the workspace's Zwingd app and shows "My account" instead of "Log in". It also lets that member buy straight to payment: no checkout pop-up and no email to type. The website never shows a sign-in form of its own.

It implements [session hand-over v1 and v1.1](https://github.com/ZwingD/zwingd-backend/blob/develop/docs/storefront-api/session-handover-v1.md). That document is the contract, and the kit follows it rule for rule. The platform's own guide for website teams is [website-kit.md](https://github.com/ZwingD/zwingd-backend/blob/develop/docs/storefront-api/website-kit.md).

| Package | For |
|---|---|
| `@zwingd-ce/website-kit` | The core. No framework and no runtime dependency (Web Crypto and `fetch` only). Runs on Node 18.17+ and edge runtimes |
| `@zwingd-ce/website-kit-node` | Express and plain Node `http` servers. Re-exports the core |
| `@zwingd-ce/website-kit-next` | Next.js App Router, Next 15 and 16. Re-exports the core |

## 1. Install

```sh
npm install @zwingd-ce/website-kit-next   # a Next.js site
npm install @zwingd-ce/website-kit-node   # an Express or Node http site
```

## 2. What the platform team sets for your workspace

Ask the Zwingd platform team for these before you start. Each one is a setting of your workspace, and nothing works until it is in place.

| Setting | What it does | Who sets it |
|---|---|---|
| Your website's origin in the **session hand-over list** (`sessionReturnOrigins`), with a **client secret** for it | Lets the app send signed-in members to your site. The secret is shown once; keep it in `ZWINGD_SESSION_CLIENT_SECRET` | The platform team |
| Your website's origin in **Allowed websites** (`websiteOrigins`) | Lets your site call the API from the browser and be the return address of a checkout | Your workspace admin (Settings > Checkout), or the platform team |
| **Website checkout** on (`commerce.websiteCheckout.enabled`) | Lets a checkout return to your website at all | Your workspace admin, or the platform team |
| Checkout mode **hosted** (`commerce.checkoutMode`) | Hosted checkout is the order path member checkout uses | The platform team |

An origin is written exactly as `https://<host>` or `https://<host>:<port>`: lower case, no path, no trailing slash. Sign-in needs the first row only. Member checkout needs all four.

## 3. Server settings

Your **server** environment holds these. None of them may reach the browser, so never prefix one with `NEXT_PUBLIC_`.

| Name | Value |
|---|---|
| `ZWINGD_API_URL` | The API address |
| `ZWINGD_APP_URL` | The workspace's app address, exactly as the platform team gave it |
| `ZWINGD_REALM` | The workspace's realm |
| `ZWINGD_SESSION_CLIENT_SECRET` | The client secret for this website's origin (`zsh_` and 64 hex characters) |
| `ZWINGD_SITE_ORIGIN` | This website's origin, exactly as listed, for example `https://www.example.org` |
| `ZWINGD_INSECURE_LOCAL_COOKIES` | `true` for local development on `http://localhost` only. The kit refuses it when `NODE_ENV=production` |

The example site also reads `ZWINGD_COUNTRY_IDS`. That variable is the example's own way to price by the visitor's country (section 7), not a kit setting.

## 4. The routes the kit serves

| Route | What it does |
|---|---|
| `GET /session/start?next=<path>` | "Log in". Sends the browser to the app's hand-over, always with `prompt=login`. The kit never runs a silent check, and a page view never starts one |
| `GET /session/callback` | The app sends the browser back here. The code is exchanged once, server to server, and the site's session cookie is set. It renders nothing |
| `POST /session/end` | "Sign out". A same-site form POST only; the website and the app both sign out. The form's `next` (the page it was on) brings the member back there afterwards: see "Back to the page after sign-out" |
| `GET /session/me` | Who is signed in, by name only, and where "Go to my account" opens, for pages that read the member in the browser (client mode) |
| `POST /session/checkout` | Member checkout: the member's "Buy now" (section 7). Served when you pass a checkout to the routes |

## 5. Next.js (App Router)

`examples/next-site` is a working site. Copy these pieces into yours.

1. **`lib/zwingd.ts`** makes the kit from the server environment on first use, so `next build` never needs the secret. It also makes the member checkout.
2. **`app/session/[action]/route.ts`** serves every route above:
   ```ts
   import { createSessionRoutes } from "@zwingd-ce/website-kit-next";
   import { memberCheckout, zwingd } from "@/lib/zwingd";
   export const dynamic = "force-dynamic";
   export function GET(request: Request) { return createSessionRoutes(zwingd(), { checkout: memberCheckout() }).GET(request); }
   export function POST(request: Request) { return createSessionRoutes(zwingd(), { checkout: memberCheckout() }).POST(request); }
   ```
3. **The header** (`app/layout.tsx`): see "Server mode or client mode" below.
4. **`proxy.ts`** (Next 16; on Next 15 name it `middleware.ts` and export `middleware`) brings a member back to the page they signed out from:
   ```ts
   import { signOutReturn } from "@zwingd-ce/website-kit-next";
   import { zwingd } from "@/lib/zwingd";
   export function proxy(request: Request) { return signOutReturn(zwingd(), request); }
   export const config = { matcher: "/" };
   ```

### Back to the page after sign-out

The app's sign-out always returns the browser to your site's `/`. So `POST /session/end` keeps the page the form named as `next` (the saved-path rule, as for `/session/start`: anything unsafe is `/`) in a 10-minute cookie, and `signOutReturn` on `/` sends the member on to it, once. `AccountButton` sends the current page. A form of your own adds `<input type="hidden" name="next" value="/the/page">`. Without `next`, the member stays on `/` as before.

### Server mode or client mode

**Server mode** suits dynamic pages. The server reads the member, by name only, and hands it to the button:

```tsx
import { AccountButton, MemberProvider } from "@zwingd-ce/website-kit-next/client";
import { accountUrl, getMember, signOutToken } from "@zwingd-ce/website-kit-next/server";

const kit = zwingd();
const [member, csrf, account] = await Promise.all([getMember(kit), signOutToken(kit), accountUrl(kit)]);

<MemberProvider member={member} signOutToken={csrf} appUrl={kit.config.appUrl} accountUrl={account} coursePath={kit.config.coursePath}>
  <header>… <AccountButton className="…" /></header>
</MemberProvider>
```

**Client mode** suits cached or static pages. A page that is cached for everyone must not carry one member's name, so the browser reads `GET /session/me` once after the page loads instead:

```tsx
<MemberProvider mode="client" appUrl={process.env.ZWINGD_APP_URL!} coursePath="/communities/courses/:code">
  <header>… <AccountButton className="…" /></header>
</MemberProvider>
```

- Until the answer arrives, the button draws an empty placeholder, so "Log in" never flashes for a member.
- The read gives up after about 5 seconds and shows "Log in", so a slow API never leaves the header empty. It asks again only on the visitor's next focus or click on the button, never on a timer.
- When that retry turns a focused "Log in" into "My account", focus moves to "My account".
- `/session/me` answers `{ member: { firstName?, lastName? } | null, signOutToken, accountUrl }` with `Cache-Control: no-store`, to same-origin requests only. `accountUrl` is set while signed in.

### AccountButton

`AccountButton` is unstyled. Give it your labels (`labels={{ logIn: "Sign in" }}`) and a class on each part it draws:

| Prop | Part |
|---|---|
| `className` | The root of each state: the `<details>` when signed in. Also used by the Log in link and the placeholder when they have no class of their own |
| `loadingClassName` | The empty placeholder while client mode waits |
| `logInClassName` | The "Log in" link |
| `triggerClassName` | "My account" (the `<summary>`) |
| `menuClassName` | The menu that opens under it |
| `itemClassName` | Each menu item. Also used by the sign-out button when it has no class of its own |
| `signOutFormClassName` | The sign-out `<form>` |
| `signOutClassName` | The "Sign out" button |

Two more props: `next` (the page to come back to after logging in or signing out; default: this page) and `accountPath` (see below).

### Where "Go to my account" and course links open

"Go to my account" is a plain link into the app, `<ZWINGD_APP_URL><path>`. The member is signed in to the app already. The path is, in order:

1. the `accountPath` prop of `AccountButton`, or the kit setting `accountPath` (`configFromEnv(process.env, { accountPath: "/communities/learning" })`);
2. else the **workspace's own landing path**, the one its app opens after sign-in. The kit reads it on your server from the API's public sign-in options, about every 5 minutes;
3. else `/`, the app's home. This includes when the read fails.

A path that is not a same-origin path is refused: the setting at start-up, the prop by being ignored.

For "You already have this course", link to that course with `useCourseUrl()(code)` in a Client Component, or `kit.courseUrl(code)` on the server. `courseUrlFor(appUrl, code, coursePath)` works anywhere. Give the kit the app's page for one course as the setting `coursePath`, with `:code` in it (SCPMI's app: `/communities/courses/:code`), and pass it to `MemberProvider` as `coursePath`. Without it, or for a code that is not a course code, the link opens the member's learning page, `/communities/learning`.

## 6. Express and Node http

```ts
import express from "express";
import { configFromEnv, createMemberCheckout, createSessionHandler, createWebsiteKit, getMember, signOutFormToken } from "@zwingd-ce/website-kit-node";

const kit = createWebsiteKit(configFromEnv(process.env));
// countryIdFor is yours: your geo header mapped to a master-data country id, or null.
const checkout = createMemberCheckout(kit, { visitorCountry: (req) => countryIdFor(req.headers["x-country"]) });
const app = express();

// Serves the five routes in section 4. Without { checkout }, POST /session/checkout is left to your site.
// Mounted for every path, it also brings a member back from the app's sign-out (which lands on /).
app.use(createSessionHandler(kit, { checkout }));

app.get("/", async (req, res) => {
  const check = await getMember(kit, req, res); // clears the cookie when the session is over
  if (check.status === "signed-in") {
    const csrf = signOutFormToken(kit, req, res);
    // "My account" plus a sign-out form:
    // <form method="post" action="/session/end"><input type="hidden" name="csrf" value="${csrf}">
    //   <input type="hidden" name="next" value="${req.path}"><button>Sign out</button></form>
    // "Go to my account": <a href="${await kit.accountUrl()}">
  } else {
    // "Log in" links to /session/start?next=/
  }
});
```

## 7. Member checkout

A member signed in on your website buys with one click. A visitor who is not signed in keeps your own guest checkout (the website checkout pop-up). Your site picks between them by whether the visitor has a session.

1. **Make the checkout once on the server:** `createMemberCheckout(kit, { visitorCountry })`.
   - `visitorCountry(request)` returns the visitor's master-data country id from your host's geo header, or null. It prices only a member whose profile has no country.
   - The country never comes from the request body.
   - The example maps `x-vercel-ip-country` through `ZWINGD_COUNTRY_IDS`.
2. **Serve the route:** pass `{ checkout }` to `createSessionRoutes` (Next) or `createSessionHandler` (Node).
3. **Show the member's own price.** On the course page, on the server, call `getMemberQuote(checkout, offer, { visitorCountry })` (Next: from `@zwingd-ce/website-kit-next/server`), or `checkout.getMemberQuote(cookies, offer, { visitorCountry })`.
   - Show its `totalMinor`, scaled by `minorUnitExponent`. That is exactly what a start charges.
   - If `quote.alreadyEnrolled` is true, show "You already have this course" instead of a button.
4. **Buy now (in the browser):**
   ```ts
   import { startMemberCheckout } from "@zwingd-ce/website-kit-next/client";
   const result = await startMemberCheckout(offer, {
     csrf,                                     // see "The CSRF value"
     expectedTotalMinor: quote.totalMinor,     // the price the page SHOWED
     paymentGateway: quote.gateways[0]?.paymentGateway,
     storageKey: (orderId) => `mysite:checkout:order:${orderId}`, // what your return page reads
     coursePath: location.pathname,
   });
   ```

| `result` | What happened | What the page does |
|---|---|---|
| `redirect` | The order was made and the order token is stored. The browser is on its way to payment, or straight to your return page when nothing was owed (`result.settled`) | Nothing: the browser comes back to `<origin>/checkout/return/<orderId>` |
| `already-owned` | The member already has the course (`ALREADY_ENROLLED`), or the order settled at once but its token could not be kept | Show "You already have this course". Never offer guest checkout |
| `fallback`, `price-changed` | The price moved since the page was shown. The kit quoted again once and starts nothing at a price the page did not show. `result.quote` holds the new price when it could be read | Show the new price; the next click uses it |
| `fallback`, `checkout-disabled` | The workspace has website checkout off | Use your guest checkout's own fallback |
| `fallback`, `signed-out` | No session, or the API said it is over (the cookie is cleared) | Use your guest checkout |
| `fallback`, `not-available` | This API has no member checkout | Use your guest checkout |
| `fallback`, `refused` | Another refusal; `result.refusal` holds its code (for example `BUYER_NOT_ELIGIBLE`) | Say checkout isn't available for this course, or use your guest checkout |
| `fallback`, `unavailable` | The API could not answer (busy, down, a timeout). A start is never retried | Say checkout isn't available right now, or use your guest checkout |
| `fallback`, `storage-unavailable` | The browser could not keep the order token, so the return page could not read the order. The browser is not sent to payment | Use your guest checkout |

A settled order (nothing owed) always answers `already-owned`, never a `fallback`, even when its order token could not be kept. The API issues a token for every start; a missing one means a misconfigured API, which the API reports itself.

### The CSRF value

`/session/end` and `/session/checkout` take a same-site POST only, carrying the CSRF value in the form. Both use one rule. The CSRF cookie is `HttpOnly`, so the page gets the value from the server:

- **server mode:** `signOutToken(kit)` (Next) or `signOutFormToken(kit, req, res)` (Node), rendered into the page;
- **client mode:** `/session/me`'s `signOutToken`.

### What your return page reads

Before it navigates, `startMemberCheckout` stores one record in `sessionStorage` under `storageKey(orderId)`:

```json
{ "orderId": "<24 hex>", "token": "<order read token>", "email": "", "coursePath": "/courses/x", "expiresAt": "<ISO time>", "member": true }
```

- `email` is always `""`: the kit stores no contact detail with a member's order.
- `member: true` tells your return page this is a member's order, so it can skip the guest's "Log in with …" hint.
- The return page confirms the payment and reads the order with `token`, exactly as for a guest. The token is never put in an address.

## 8. What never to do

- Never prefix a `ZWINGD_*` setting with `NEXT_PUBLIC_`, or send the client secret, the session token or the order token anywhere but where the kit sends them.
- Never log a token, the client secret or the order token. The kit itself logs nothing.
- Never take a return address from the browser. The kit always returns to `<origin>/checkout/return/<orderId>`.
- Never send a price the page did not show. `expectedTotalMinor` is the member quote's `totalMinor`, unchanged.
- Never start a hand-over on a page view. Only a click on "Log in" starts one.
- Never show a sign-in form, or collect a password or a code, on your website.

## What the kit does for you

- **Callback:** the code is exchanged exactly once, and a failed exchange is never retried.
- **Saved path:** the `next` path is checked against the contract's saved-path rule and its fixtures. Anything that is not a same-origin path becomes `/`.
- **Cookies:** all three are `__Host-`, `HttpOnly` and `Secure`. Each removal also carries `Secure; Path=/`.
- **Sign-out:** the cookies are cleared whatever the API answers, and the member is sent on to the app's sign-out.
- **Session checks:**
  - a check is cached for 60 seconds;
  - the session is dropped only on `active: false`, never on a 429, a 503 or a timeout;
  - contact details are answered only from a check under 60 seconds old, so use `freshMember` / `getCheckoutMember` before a checkout prefill.
- **Member checkout:** the server calls the API with the client secret and the session cookie's token, waiting 10 s for a quote and 30 s for a start.

## Local development

1. Set `ZWINGD_INSECURE_LOCAL_COOKIES=true` and `ZWINGD_SITE_ORIGIN=http://localhost:3100`.
2. Have the platform team list that origin for the dev workspace.
3. Run `pnpm --filter next-site dev`.

## Development

```sh
pnpm install
pnpm -r type-check && pnpm -r test && pnpm -r build
```

**Releases:**
1. Run `pnpm -r test` with a `zwingd-backend` checkout beside this repo, so the saved-path fixtures test compares against the contract. CI cannot read the private repo and skips it.
2. Push a tag `vX.Y.Z`. The release workflow publishes every package after type-check, tests and build pass.

The version bump and the publish are the operator's.
