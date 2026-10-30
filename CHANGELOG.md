# Changelog

## Unreleased

## 0.2.1

Two fixes to the code step's terms box (seen on SCPMI's stage checkout, 2026-10-30). Not released yet: the `v*` tag needs the operator's go.

- **Ticking the terms box no longer clears the code.** The hook cleared the code whenever the step's error went back to null while a code had been asked for, so ticking the box after "Continue" (which clears the terms error) wiped the six digits the buyer had typed. The code is now cleared only when a new code is asked for (the step opens, or a new code is sent).
- **`WEBSITE_TERMS_REQUIRED` has its own line.** Continue without the box ticked said the box's own sentence ("I agree to the {terms links}.") as the error. It now says `CODE_STEP_COPY.termsRequired`, "Accept the terms to continue." (Helm's signed line for this refusal, #5 on #1963).

## 0.2.0

Checkout v3.2: the buyer proves their email by code before payment (ZwingD/zwingd-backend#1963, spec v3.2). Needs the API's website code and proof routes (zwingd-backend#1984); a site that does not use them is unchanged. Not released yet: the `v*` tag needs the operator's go.

The code step creates **no account and no session**. A right code gives the site's server a short-lived verified-email proof, held in an HttpOnly cookie; payment goes ahead against it; after payment the buyer continues into the app with the same proof.

### Routes `handle()` now claims

Node (`createSessionHandler`) and Next (`createSessionRoutes`) serve them through the same `/session/[action]` route. A site that already serves any of these paths itself must move it.

- `GET /session/code-step`: same-origin read of the form value (`formToken`, posted as `csrf`), the open step a reload resumes (`pending`), and, once the code was right, the held proof (`held: { email, offer }`, never the proof) a reload resumes at "Pay {amount}" (Helm #18 on #1963).
- `POST /session/code-start`, `/session/code-resend`, `/session/code-verify`, `/session/code-pay`, `/session/code-requote`, `/session/checkout-continue`: same-site POST with `csrf` (the kit's one rule).
  - code-start takes `country` (24 hex, the page's), else the kit's `visitorCountry`. With neither it answers `400 COUNTRY_REQUIRED` and sends NO code, decided before the API is asked and the same for every email (Helm #4): nothing is spent, nothing enumerated. A malformed `country` is `400 INVALID_REQUEST`. The ticket cookie keeps the country for "Send a new code" after expiry.
  - code-requote (Helm #18): a reload while the proof is held quotes the purchase again with it and ALWAYS answers `confirm-price` (or `already-owned`, or the proof-gone `payment-failed`, which drops both cookies); it never starts a payment.
  - start/resend/verify call the API's `code/start|resend|verify` with the buyer's IP. Refusals answer the browser `{ reason, retryAfterSeconds?, fields? }` only, never the API's sentence. `WEBSITE_CODE_DISABLED` passes through as 409.
  - resend on an expired ticket (or one the API calls `WEBSITE_CODE_EXPIRED`) starts again with the stored email.
  - verify keeps the proof in `__Host-zw_proof` (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age = `proofExpiresInSeconds` + 30 min, the most the API's PAID extension adds, so a buyer who pays near the end still gets the thank-you button), then re-quotes with `checkoutProof` + `buyerIp`. Same total → `checkout/start` at once and `{ kind: "redirect", url, orderId, orderToken, ... }`; changed → `{ kind: "confirm-price", totalMinor, currencyCode, minorUnitExponent }`; also `already-owned` and `payment-failed { reason }`. The proof is never in an answer.
  - verify takes `expectedCurrencyCode` (ISO 4217) with `expectedTotalMinor`: the same number in another currency is a changed price (`confirm-price`), never "unchanged" (A2).
  - verify, code-pay and code-requote refuse `400 INVALID_REQUEST` (for verify BEFORE the code is spent) when the purchase is missing (`offer`, `expectedTotalMinor`, `expectedCurrencyCode`) or a field it sent is in the wrong shape (`country`, `couponCode`, `paymentGateway`, ...). Nothing is dropped silently: a dropped country or coupon would re-quote another price.
  - every start sends `expectedCurrencyCode` with `expectedTotalMinor` (Helm #14): an API that compares it refuses a currency change PRICE_CHANGED; an older one ignores the key.
  - verify, code-pay and code-requote take `country`: the master-data country id the page priced `expectedTotalMinor` in, else the kit's `visitorCountry`. It is sent as the API's `visitorCountry`, its FALLBACK: a verified member is priced in their profile country first (A2, Helm #23), and a changed total is shown as "Pay {amount}" before any payment; a non-member keeps the shown total.
  - after a right code the ticket cookie stays as the held-proof marker (email, offer, country and the order the proof started; HttpOnly, as long as the proof cookie lives); verify and resend treat it as no open step.
  - code-pay is the "Pay {amount}" press: a start with the held proof at the shown total; PRICE_CHANGED quotes again once and answers `confirm-price`.
  - checkout-continue is the thank-you press, fetched by `CheckoutContinueButton` (`Accept: application/json`): `checkout-proof/continue` mints the 60 s single-use nonce at the press, and the route answers `{ nonce, continueUrl }` (continueUrl only https with exactly the path `/session/checkout-continue`, no query or fragment). The button then submits a hidden form POST with `nonce` to `continueUrl`; the nonce is kept only in that handler and the form's body; with the default submit the form is removed once sent. One press on the website (a double click still mints one nonce); the app still asks "Continue as {email}". The press sends `orderId`, and the kit mints only when the held proof started that order in this browser (Helm #26, a kit-only check: the API's proof context names no order). Past the same-site check, any failure answers `400 { signInUrl }`; on any failure the button opens the app's sign-in.
- `POST /session/end` also clears `__Host-zw_ticket` and `__Host-zw_proof`.
- A code POST (or the thank-you press) answered 403 because the form value went stale (`/session/me` drops it for an ended session; a sign-out in another tab) is sent again ONCE with a freshly read value (when it differs); the kit answers 403 before any API call, so nothing is spent. A thank-you button whose form value cannot be read still presses, and opens the app's sign-in.
- Drop-off: the kit reports `code_sent` after a start when the step has an `offer`. The start waits for it (at most 2 s; a failure never fails the start), as a promise left running is dropped on serverless hosts. Identity records "verified" itself.

### TypeScript interface changes

- `WebsiteKitConfigInput` (all optional): `buyerIpFrom(headers)` (default `forwardedBuyerIp`: `x-real-ip`, else the last `x-forwarded-for` hop; never the browser-set first hop) and `visitorCountry(req)` (the code step's quote; `createMemberCheckout` falls back to it).
- `WebsiteKitConfig` (resolved) gains **required** `buyerIpFrom: BuyerIpResolver` and `visitorCountry: VisitorCountryResolver | null`. Code that builds a `WebsiteKitConfig` by hand instead of through `resolveConfig` / `configFromEnv` must add them.
- `CookieNames` gains **required** `ticket` (`__Host-zw_ticket` / `zw_ticket`) and `proof` (`__Host-zw_proof` / `zw_proof`).
- `WebsiteKit` gains **required** methods `codeStep`, `codeStart`, `codeResend`, `codeVerify`, `codePay`, `codeRequote`, `checkoutContinue` and `checkoutContinueFor(cookies, { orderId })`. A hand-written `WebsiteKit` (a test double) must add them.
- `SESSION_PATHS` gains `codeStep`, `codeStart`, `codeResend`, `codeVerify`, `codePay`, `codeRequote`, `checkoutContinue` (also as `CODE_PATHS`).
- `VisitorCountryResolver` now lives in the config module; the export name is unchanged.
- Core exports added: `CODE_PATHS`, `CODE_STEP_COPY`, `codeStepAnnouncement`, `codeStepError`, `codeStepReducer`, `fillCopy`, `formatAmount`, `initialCodeStep`, `normalizeCode`, `PROOF_GONE_REASONS`, `resendCountdown`, `UNAVAILABLE_REASON`, `CODE_CALL_TIMEOUT_MS`, `CODE_REASONS`, `APP_CONTINUE_PATH`, `forwardedBuyerIp`, `storeCheckoutOrder`, `readCheckoutOrder` (the return page's checked read of that record), `KIT_REASONS`, and the types `CheckoutContinue` (`orderId`, `continueAs`, `label`, `action`, `signInUrl`; ⛔ keep `continueAs` out of browser storage, addresses and logs, Helm #19), `CheckoutContinueAnswer`, `CodeStepRead`, `CodeStepState`, `CodeStepAction`, `CodeStepError`, `CodeStepField`, `CodeStepName`, `CodeStepPayment`, `CodeStepPrice`, `CodeStepRefusal`, `CodeStepTicket`, `CodeStepCopyKey`, `PendingCodeStep`, `HeldCodeStep`, `AcceptedDocument`, `CodeReason`, `ContinueAs`, `BuyerIpResolver`, `StoredVerifiedCheckout`, `StoredCheckout`, `KitReason`, `CodeStepReason`.
- Reasons are typed `CodeStepReason` (`CodeReason` | `KitReason` | the checkout start's `PRICE_CHANGED`, `ALREADY_ENROLLED`, `HOSTED_GUEST_INVALID` | any other string): `CodeStepError.reason`, `CodeStepRefusal.reason`, the `payment-failed` reason. `PROOF_GONE_REASONS` is `readonly CodeReason[]`, and the kit's server drops the proof cookie on that same list.
- `CodeStepAction`'s `failed` takes a **required** `now` (the resend cap's wait is held from it). A site driving `codeStepReducer` itself must pass it. New action `resume { email }` and step `resuming` (Helm #18): a held proof is quoted again, then `confirm-price`; a proof gone, or no answer, goes back to `email` with no error.
- `CodeStepField` gains `country` (`COUNTRY_REQUIRED`); `KIT_REASONS` gains `COUNTRY_REQUIRED`.
- `CODE_STEP_COPY` gains the lines Helm signed on #1963 (#5, #16): `payStartFailed` ("We couldn't start your payment. Try again.", a payment that may start on a retry), `payFailed` ("We couldn't take this payment. Try again, or contact {workspace}.", refused for good), `proofExpired`, `proofMismatch`, `proofUnavailable`, `codesUnavailable`, `botCheck`; and `chooseCountry` ("Choose your country to continue.", COUNTRY_REQUIRED, signed by Helm on #1963 Q4). A failed payment after a right code now reads `payStartFailed` / `payFailed` instead of `otherError`; a proof gone, the setting off and the bot checks read their own lines.
- `useCodeStep`: `terms` is read live (documents loaded after the first render still show the tick box and guard Continue); `amount`, `priceLine` and `payLabel` are also set in `pay-failed` after a member price; a start or resend 200 that is not a ticket, or an open step that is not one, reads as no answer.
- `@zwingd-ce/website-kit-next/server`: `getCheckoutContinue(kit, { orderId })` (**orderId required**, Helm #26): null unless the held proof started that order in this browser.
- `@zwingd-ce/website-kit-next/client` (with the types `UseCodeStepOptions`, `CodeStep`, `CodeStepIds`, `VerifyExtras`, `CheckoutContinueButtonProps`, `CodeStepLiveRegionProps`): `useCodeStep(options)` (headless; options include the **required** `expectedCurrencyCode` and `workspaceName` (filled into `payFailed`, Helm #16), and `country` (optional, but with neither it nor the kit's `visitorCountry` the start is refused `COUNTRY_REQUIRED` at the field `country`); a reload with a held proof for the same `offer` resumes at "Pay {amount}" once the page's total and currency are set; `emailInputProps`, `codeInputProps`, `termsInputProps`, `ids`, `announcement`, `priceLine`, `payLabel`, `pay()`), `createCodeStepClient`, `CodeStepLiveRegion` (the kit's polite live region), `CheckoutContinueButton` (the one-press thank-you button; needs JavaScript; **required** `storageKey`: it is drawn only when this tab holds the verified-checkout record of `next.orderId`, Helm #26), and from the core the copy and state helpers above.

### Upgrading from the v3.1 0.2.0 draft (PR #17 before this rework)

Removed (spec v3.2 AC 17): `GET /session/app`, `GET /session/app-code`, `appLinkHref`, the `appSignIn` setting and `ZWINGD_APP_SIGN_IN` / `appSignInFromEnv`, `isNewAccount` (API and browser), `isNewAccountBuyer` (kit and `/server`), the `__Host-zw_new` cookie (`CookieNames.newAccount`), `CodeStepVerified`, `CodeStepNotice`, `state.notice`, `state.member`, `state.signOutToken`, the `verified` step and `CODE_STEP_COPY.accountReady`. A site on the draft must:

1. Drop `ZWINGD_APP_SIGN_IN` from its environment and `appLinkHref` / `isNewAccountBuyer` from its code.
2. Pass `useCodeStep` the purchase: `offer`, `expectedTotalMinor` (the guest total shown), `expectedCurrencyCode` (its currency; **required**), `country` (the master-data country id it was priced in, when the buyer can pick one; ask for it when `state.error.field === "country"`), `workspaceName` (**required**), `storageKey`, and `terms` when the workspace requires them. Draw the `resuming` step as a loading state. `verify()` no longer takes the code: spread `codeInputProps` on the one code input (no `maxLength`). Do not call `startMemberCheckout` after the step: it goes to payment itself, or to `confirm-price` with "Pay {amount}" (`step.pay()`).
3. Draw the terms tick box ("I agree to the {terms links}.", `termsInputProps`) instead of "By continuing you agree to the {terms link}.", and put `<CodeStepLiveRegion step={step} />` in the step.
4. On the return page: `getCheckoutContinue(kit, { orderId })` on the server and `<CheckoutContinueButton next={next} storageKey={...} />`, instead of the label from `isNewAccountBuyer` and a link to `/session/app`.
5. If it prices by country, pass `visitorCountry` to the kit config (member checkout inherits it).

### Example site

The course page's code step with the shown guest total, terms and the live region; the return page's button from `getCheckoutContinue`.

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
