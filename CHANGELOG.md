# Changelog

## Unreleased

## 0.2.0

Checkout v3.1: verify the buyer's email before payment (ZwingD/zwingd-backend#1963). Needs the API's website code routes; a site that does not use them is unchanged.

- New routes (Node and Next serve them through the same `[action]` route):
  - `POST /session/code-start`, `/session/code-resend`, `/session/code-verify`: the code step, same-site POST with `csrf` (the kit's one rule). They call the API's `code/start|resend|verify` with the buyer's IP. Refusals answer the browser `{ reason, retryAfterSeconds?, fields? }` only, never the API's sentence.
  - Verify sets the session like `/session/callback` (`__Host-zw_session`, `__Host-zw_csrf`, keeping the page's form value) and, for a new account only, `__Host-zw_new=1` (HttpOnly, the session's life). The browser gets `{ member, notice: 'account-ready' | null, signOutToken }`; `isNewAccount` is never in a browser answer.
  - The ticket is kept in the HttpOnly `__Host-zw_ticket` cookie for 10 minutes, so a reload after the mail app resumes the step. `GET /session/code-step` answers the form value for a signed-out visitor and the open step.
  - `GET /session/app?to=` (saved-path rule): 303 to the app's `/session/claim` when `appSignIn` is on and the buyer is signed in, else to the plain app address. `GET /session/app-code?state=&code_challenge=`: the app's claim gets a one-time code (`<appUrl>/session/claim/callback?code=&state=`) or `error=login_required`; `no-store`, `no-referrer`.
  - `POST /session/end` also clears `__Host-zw_new` and `__Host-zw_ticket`.
  - Drop-off: after start (`code_sent`) and verify (`verified`) the kit reports the stage when the step has an `offer`; fire-and-forget.
- Config: `buyerIpFrom(headers)` (default `forwardedBuyerIp`: `x-real-ip`, else the last `x-forwarded-for` hop; never the browser-set first hop) and `appSignIn` (default false; `ZWINGD_APP_SIGN_IN=on` through `configFromEnv`).
- `@zwingd-ce/website-kit-next/server`: `isNewAccountBuyer(kit)`.
- `@zwingd-ce/website-kit-next/client`: `useCodeStep()` (headless: email → sending → code → verifying → verified; countdown; errors by reason; double-submit guard; focus on the code input), `createCodeStepClient`, and from the core `CODE_STEP_COPY` (the spec's copy, word for word), `fillCopy`, `codeStepReducer`, `resendCountdown`, `appLinkHref(to)`.
- `CookieNames` gains `newAccount` and `ticket`.
- Example site: a code step on the course page, and the return page's label from `isNewAccountBuyer`.

## 0.1.3

- Fix: `signOutReturn` (Next.js) now answers an absolute `Location` on the request's own origin. Next's proxy adapter parses a proxy's `Location` with no base, so 0.1.2's relative saved path threw "Invalid URL" and the site's `/` answered 500 for a member coming back from the app's sign-out. Express and Node http (`createSessionHandler`) were not affected. Sites on 0.1.2 with `signOutReturn` in `proxy.ts` / `middleware.ts` should update.
- Docs: a developer guide for website teams, `docs/developer-guide.md` (ZwingD/zwingd-backend#1884): what to ask the workspace admin and the platform team for, server settings, member sign-in, the guest checkout pop-up and return page, member Buy Now, testing, going live and troubleshooting. The README links to it.

## 0.1.2

- Sign-out comes back to the page the member was on (#10). `POST /session/end` takes the page as the form field `next`, checks it with the saved-path rule (the same one `/session/start` uses; anything unsafe is `/`), and keeps it for 10 minutes in a new cookie (`__Host-zw_return`, `SameSite=Lax`). The app's sign-out still returns the browser to `<origin>/`; from there the kit sends it on and drops the cookie. `AccountButton`'s sign-out form sends the current page. Express and Node http do this through `createSessionHandler`; a Next.js site adds `signOutReturn` in `proxy.ts` (Next 16) or `middleware.ts` (Next 15) for `/`.
- "Go to my account" opens the workspace's own landing path (#11). The kit reads `signInOptions.landingPath` from identity's public read on `ZWINGD_API_URL` (realm header, no token), on the server, cached about 5 minutes. Any failure, an unsafe value or no value is `/`. The setting `accountPath`, or the `AccountButton` prop of that name, overrides it. Server mode passes `accountUrl={await accountUrl(kit)}` to `MemberProvider`; in client mode `/session/me` answers `accountUrl`.
- Course links for the owned-course panel (#11): `kit.courseUrl(code)`, `useCourseUrl()` and `courseUrlFor(appUrl, code, coursePath)`. With the setting `coursePath` (`:code` in it, e.g. SCPMI's `/communities/courses/:code`), the link opens that course. Without it, the link opens the member's learning page, `/communities/learning`.
- `/session/me` answers `accountUrl` beside `member` and `signOutToken`: the address while signed in, `null` otherwise.

## 0.1.1

The first published release: v0.1.0 was tagged but its release run failed before publishing, so nothing was ever on npm at 0.1.0. 0.1.1 carries everything listed under 0.1.0 and the following.

- Release and CI: `pnpm/action-setup` takes the pnpm version from `packageManager` in package.json (it refused two versions).
- `startMemberCheckout`: an order that settled at once (nothing owed) is `already-owned` when its order token cannot be kept, never a `fallback` that would offer guest checkout to an owner. The redirect answer gains `settled` (#5).
- `AccountButton`: when a client-mode retry turns a focused "Log in" into "My account", focus moves to "My account" (#5).
- Example site: the Buy now status line always has text when it is drawn (#5).
- `already-owned` carries `settled: true` when this start's order settled just now, so a site can say "This course is yours now." (the example does; Iris on #6).
- README: a full guide for website teams (install, settings, workspace set-up, routes, server and client mode, member checkout, the CSRF value, the return page record, what never to do).

## 0.1.0 (tagged, never published)

- `@zwingd-ce/website-kit`: the session hand-over v1 website contract as pure functions. It covers the `/session/start`, `/session/callback`, `/session/end` and `/session/me` flows (the last a same-origin JSON read of who is signed in), the saved-path rule with the contract's fixtures, PKCE S256, the three cookies, the exchange / session / end calls, and `getMember` with a 60 s check cache (ZwingD/zwingd-backend#1869).
- `@zwingd-ce/website-kit-node`: `createSessionHandler` for Express and Node http, plus `getMember`, `freshMember` and `signOutFormToken` for server-rendered pages.
- `@zwingd-ce/website-kit-next`: `createSessionRoutes` for the App Router; `getMember`, `getCheckoutMember` and `signOutToken` for Server Components; `MemberProvider` (server-fed, or `mode="client"` reading `/session/me`), `useMember` and an unstyled `AccountButton`.
- Member checkout (session hand-over v1.1, ZwingD/zwingd-backend#1869): `createMemberCheckout` serves `POST /session/checkout` and `getMemberQuote` from the site's server, with `startMemberCheckout` for the browser. `createSessionHandler` (Node) and `createSessionRoutes` (Next) serve the route when given a checkout; `getMemberQuote` is also on `@zwingd-ce/website-kit-next/server`.
- One same-site POST rule, `sameSitePost`, behind both `/session/end` and `/session/checkout`.
- `AccountButton` takes a class name on every part it draws (`loadingClassName`, `logInClassName`, `triggerClassName`, `signOutFormClassName`, `signOutClassName` added).
- Client mode's `/session/me` read gives up after about 5 s and shows "Log in"; it asks again on the next focus or click on the button, never on a timer.
