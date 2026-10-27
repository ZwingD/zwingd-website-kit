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
2. **`app/session/[action]/route.ts`**: serves `/session/start`, `/session/callback` and `/session/end`.
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
   `AccountButton` is unstyled. Give it your own classes and labels (`labels={{ logIn: "Sign in" }}`).
4. **`.env.example`**: the five server settings. Never prefix them `NEXT_PUBLIC_`.

**Rules the kit already keeps for you:**
- A plain page view never contacts the app. Only a click on "Log in" starts a hand-over.
- `getMember` returns the name only.
- For a checkout prefill, use `getCheckoutMember`. It makes a fresh check and returns an email or phone only when that check succeeded.
- A member's Buy Now that goes straight to payment arrives with the member checkout routes (KIT-3). Until then, Buy Now stays your existing guest checkout.

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

// Serves GET /session/start, GET /session/callback and POST /session/end.
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
- **Sign-out:** `/session/end` accepts a same-site POST only, carrying the form's CSRF value. Its cookies are cleared whatever the API answers, and the member is sent on to the app's sign-out.
- **Session checks:** a check is cached for 60 seconds. The session is dropped only on `active: false`, never on a 429, a 503 or a timeout. Contact details are answered only from a check under 60 seconds old. Use `freshMember` before you prefill a checkout.
- **Secrets:** no token, secret, verifier or code is ever logged, thrown or put in a URL beyond the contract's own redirects.

For local development against `http://localhost`, pass `insecureLocalCookies: true`. This uses unprefixed cookie names without `Secure`, and the kit refuses it when `NODE_ENV=production`.

## Development

```sh
pnpm install
pnpm -r type-check && pnpm -r test && pnpm -r build
```

Releases: first run `pnpm -r test` with a `zwingd-backend` checkout beside this repo, so the saved-path fixtures test compares against the contract (CI cannot read the private repo and skips it). Then push a tag `vX.Y.Z`. The release workflow publishes every package after type-check, tests and build pass.
