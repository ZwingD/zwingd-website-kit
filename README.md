# Zwingd website kit

The kit lets a workspace's own website recognise a member who is signed in to the workspace's Zwingd app. The website shows "My account" instead of "Log in" and never shows a sign-in form of its own.

It implements [session hand-over v1](https://github.com/ZwingD/zwingd-backend/blob/develop/docs/storefront-api/session-handover-v1.md). That document is the contract, and this kit follows it rule for rule.

| Package | For |
|---|---|
| `@zwingd-ce/website-kit` | The core. No framework and no runtime dependency (Web Crypto and `fetch`). Node 18.17+ and edge runtimes |
| `@zwingd-ce/website-kit-node` | Express and plain Node `http` servers |
| `@zwingd-ce/website-kit-next` | Next.js App Router (coming next) |

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
