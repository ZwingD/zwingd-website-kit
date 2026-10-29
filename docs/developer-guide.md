# Developer guide for a client website team

This guide is for the team that builds a workspace's own website: the public site where people read about courses and buy them. It explains how the website lets a member sign in, see "My account" and sign out, and how anyone can buy a course on the website and come back to it after paying.

The [README](../README.md) is the code reference for the kit: every route, prop and result. This guide is the walk-through around it. Where the two differ, the README is right.

## Contents

1. [What you are building](#1-what-you-are-building)
2. [Before you start: what to ask for](#2-before-you-start-what-to-ask-for)
3. [Server settings](#3-server-settings)
4. [Member sign-in: log in, My account, sign out](#4-member-sign-in-log-in-my-account-sign-out)
5. [Guest checkout: the checkout pop-up](#5-guest-checkout-the-checkout-pop-up)
6. [The return page](#6-the-return-page)
7. [Member Buy Now](#7-member-buy-now) (and [verify email before payment](#7a-verify-the-buyers-email-before-payment-v020))
8. [Member event registration](#8-member-event-registration)
9. [Testing and fixtures](#9-testing-and-fixtures)
10. [Going live](#10-going-live)
11. [Troubleshooting](#11-troubleshooting)

## 1. What you are building

Three things, and each one works without the others:

| Part | What the visitor sees | Built with |
|---|---|---|
| **Member sign-in** | "Log in" in your header. After signing in on the workspace's app, the visitor comes back to your page and sees "My account" with their name. "Sign out" signs them out of both | The kit's routes and `AccountButton` |
| **Guest checkout** | "Buy now" opens a checkout pop-up on your website that asks only for an email. The visitor pays on the payment page and lands back on your website's thank-you page | Your own pop-up and return page, calling the public checkout API from the browser |
| **Member Buy Now** | A signed-in member presses "Buy now" and goes straight to payment, with no pop-up and no email to type, at their own price | The kit's member checkout |

Some things never change, whichever part you build:

- **The platform owns the order.** Price, tax, invoice, payment, course access and the emails all stay with the workspace's platform. Your website draws the screens.
- **Your website never shows a sign-in form.** Members sign in on the workspace's app, never on your pages. Never collect a password or a sign-in code.
- **Buying never needs a sign-in.** A visitor who is not signed in can always buy as a guest.
- **The price you show is the price charged.** Always show the price the API quoted, never one you worked out.

## 2. Before you start: what to ask for

Nothing works until the workspace is set up for your website. Two people do this: the **workspace admin**, in the workspace's own settings, and the **platform team**, who look after the platform the workspace runs on.

Write your website's address as an **origin**: `https://<host>` or `https://<host>:<port>`, lower case, with no path and no trailing slash. For example `https://www.example.org`. If your site answers on more than one host (with and without `www`), each host is its own origin.

### Ask the workspace admin

In the workspace's settings, on the **Checkout & payments** page:

| Setting | What it does | Needed for |
|---|---|---|
| **Allowed websites**: add your origin | Lets your pages call the checkout API from the browser, and lets a checkout return to your website | Guest checkout, member Buy Now |
| **Allow website checkout**: on | Lets a checkout that started on your website go ahead | Guest checkout, member Buy Now |
| **Who can buy**: **Anyone, with their email (no account needed)** | Lets visitors buy without an account | Guest checkout |
| **How learners pay**: **In this app** | Turns on the workspace's own checkout, which website checkout and member Buy Now use behind the scenes. "On your own website" means something else (a website that takes payments itself) and switches it off | Guest checkout, member Buy Now |

The same page has a read-only **Your websites** list. It shows each of the workspace's websites, whether member sign-in is set up for it, and whether checkout is allowed. Use it to check the set-up.

### Ask the platform team

| What | Why | Needed for |
|---|---|---|
| **List your origin for member sign-in** | Lets the app send signed-in members back to your website | Member sign-in, member Buy Now |
| **The client secret for that origin** | Your server proves it is your website with it. It is created once and shown once | Member sign-in, member Buy Now |
| **The app address** and **the realm** | Where members sign in, and which workspace your website belongs to | Everything |
| **The API address** | Where your server and pages call | Everything |

The client secret is a password. Ask for it to be handed over through a secure channel your teams agree on, such as a password manager share. Never by email or chat, never in a ticket, never in your repository. If it ever leaks, ask the platform team to replace it: a new secret stops the old one working.

A workspace can list at most 5 websites for member sign-in and at most 10 allowed websites.

## 3. Server settings

Your **server** environment holds these. None of them may reach the browser. On Next.js, never give one a `NEXT_PUBLIC_` name.

| Name | Value | Needed for |
|---|---|---|
| `ZWINGD_API_URL` | The API address the platform team gave you | Everything |
| `ZWINGD_APP_URL` | The workspace's app address, exactly as the platform team gave it | Member sign-in |
| `ZWINGD_REALM` | The workspace's realm | Everything |
| `ZWINGD_SESSION_CLIENT_SECRET` | The client secret for this website's origin: `zsh_` followed by 64 hex characters | Member sign-in |
| `ZWINGD_SITE_ORIGIN` | This website's origin, exactly as it was listed | Member sign-in |
| `ZWINGD_INSECURE_LOCAL_COOKIES` | `true` for local development on `http://localhost` only. The kit refuses it when `NODE_ENV=production` | Local development |

The code step (v0.2.0) also needs the buyer's IP. The kit's default `buyerIpFrom` reads `x-real-ip`, else the last `x-forwarded-for` hop (both written by your own proxy; the first hop is whatever the browser sent). That is right on Vercel and behind one load balancer. Anywhere else, pass `buyerIpFrom` to `configFromEnv`. Pass `visitorCountry` too if you price by the visitor's country: the code step's quote uses it, and member checkout inherits it.

The kit checks every setting when it starts. A missing or malformed one throws `WebsiteKitConfigError`, which names the setting and never its value.

Guest checkout runs in the browser, so your pages also need the API address and the realm there. Both are public values; the client secret is not, and never goes to the browser.

`examples/next-site/.env.example` lists the example site's settings. It also reads two of its own: `ZWINGD_COUNTRY_IDS` (the visitor's country for pricing, section 7) and `ZWINGD_COURSE_PATH` (the app's page for one course, see the README).

## 4. Member sign-in: log in, My account, sign out

Install the package for your server:

```sh
npm install @zwingd-ce/website-kit-next   # Next.js (App Router, Next 15 or 16)
npm install @zwingd-ce/website-kit-node   # Express or plain Node http
```

The kit runs on your server. It adds these routes to your website:

| Route | What it does |
|---|---|
| `GET /session/start?next=<path>` | "Log in": sends the browser to the app's sign-in |
| `GET /session/callback` | Where the app sends the browser back. Your server swaps the one-time code for its own session cookie |
| `POST /session/end` | "Sign out": signs out of your website and the app |
| `GET /session/me` | Who is signed in, by name only, for pages that read the member in the browser |
| `POST /session/checkout` | Member Buy Now (section 7) |

The README's sections 5 (Next.js) and 6 (Express and Node http) have the code. `examples/next-site` is a working Next.js site to copy from.

### Log in

1. The visitor presses "Log in". The link is `/session/start?next=<this page>`.
2. The kit sends the browser to the workspace's app. A visitor who is not signed in there signs in with their email and a code the app emails them.
3. The app sends the browser back to `/session/callback` with a code that works once and lives 60 seconds.
4. Your server swaps the code for a session, sets an `HttpOnly` cookie and sends the browser back to the `next` page.

Start a log-in only when the visitor presses "Log in". Never on a page view.

### My account

`AccountButton` shows "Log in" or "My account" with the member's name. Its menu has "Go to my account" (a link into the app) and "Sign out". It is unstyled: give it your labels and a class on each part (README, "AccountButton").

Choose how the header reads the member:

- **Server mode**, for pages rendered per request: the server reads the member and passes it to `MemberProvider`.
- **Client mode**, for cached or static pages: the browser asks `/session/me` once after the page loads. A page cached for everyone must never carry one member's name.

The kit checks the member's session with the API at most once a minute. A member who signs out in the app is signed out on your website within about a minute.

### Sign out

"Sign out" is a form that posts to `/session/end`. The kit ends your website's session, then sends the browser to the app to end its session there too. The app sends the browser back to your website's `/`, and the kit sends the member on to the page they signed out from (README, "Back to the page after sign-out").

## 5. Guest checkout: the checkout pop-up

The kit does not draw the pop-up. You build it in your own design and call the public checkout API from the **visitor's browser**, with the workspace's realm in the `realm` header. Never call these from your server: the API limits requests per visitor address, so a start from your server would be refused or count every visitor as one.

1. **Can the website sell?** When the course page loads, read `websiteCheckoutStatus`. It answers only `available`: true when website checkout is on, guests can buy and at least one website is allowed.
   - `available`: "Buy now" opens your pop-up.
   - not available: "Buy now" opens the course in the workspace's app instead, where its own checkout runs.
2. **The order card.** Read the offer and its price with `hostedCheckoutOffers` and `hostedCheckoutQuote`, for the visitor's country. If the quote differs from the price on your page, show the quote.
3. **The email step.** Ask only for an email. Check its format, show the bot check the email step asks for, then call `hostedCheckoutEmailCheck` with the email and the offer. It answers yes or no facts only:
   - `hasCourseAccess`: this email already has the course. Show "You already have this course", with a button to log in and a button to use a different email. Nothing is charged.
   - `documentsRequired`: show the terms checkbox with the workspace's documents before the visitor can continue.
4. **Start.** Call `startHostedCheckout` with the guest's email and country, the accepted documents when they were required, and `returnUrl = <your origin>/checkout/return`. Keep the order token it answers in `sessionStorage` (section 6), then send the browser to the payment address it answers.
5. **Payment.** The visitor pays on the hosted payment page and comes back to `<your origin>/checkout/return/<orderId>`.

Rules for the pop-up:

- Disable "Continue" while a request runs, so one click makes one start.
- Keep keyboard focus inside the pop-up while it is open, and return it to "Buy now" when it closes. On a narrow screen, a bottom sheet works well.
- Don't let the visitor close the pop-up while it is taking them to payment.
- Never show anything about another person: no name, avatar or other purchase, even when the email already has an account.
- Send no email address or personal data to your analytics.

If a start is refused because website checkout is off (`WEBSITE_CHECKOUT_DISABLED`), say "Online checkout isn't available on this website right now." and offer the app's checkout for the course.

## 6. The return page

Every checkout, guest or member, comes back to `<your origin>/checkout/return/<orderId>`. The kit never takes a return address from the browser, and neither should your pop-up.

1. **Read the order token** from `sessionStorage`, under the key you stored it with. It is never in the address: addresses end up in browser history and logs.
2. **Confirm the payment** with `confirmHostedCheckoutPayment(orderId, token)`, then read the order with `myOrder(orderId, token)`. Reloading the page is safe: confirming twice gives the same answer.
3. **Show the result.** The order's `buyerAccount` says whether the purchase created a new account (`NEW_ACCOUNT`) or went to an existing member (`EXISTING_MEMBER`), so you can pick the right words. Show the cancelled, failed and pending states too, never a blank page.
4. **Receipt.** A "Download receipt" button calls `myOrderReceipt` with the order token and saves the PDF it answers.
5. **Log in.** For a guest, link to the app's sign-in with the email they typed: `<ZWINGD_APP_URL>/?email=<email>&next=/my-learning`. The app fills in the email and opens the member's learning after sign-in. Never put the order token in this address.

A member's order record (section 7) has `member: true` and an empty `email`, so skip the "log in with your email" step for it.

If the token isn't there (another browser, or a private window that was closed), say so and ask the buyer to open the page in the browser they paid in. Their purchase is safe either way: the platform settles it and emails them.

## 7. Member Buy Now

A member signed in on your website buys with one click. A visitor who is not signed in keeps your guest checkout.

1. **On the server, make the checkout once:** `createMemberCheckout(kit, { visitorCountry })`. `visitorCountry` maps your host's geo header to the workspace's country id, or answers null. It prices only a member whose profile has no country. The example site maps the geo header through `ZWINGD_COUNTRY_IDS`; ask the workspace admin or the platform team for the country ids.
2. **Serve the route:** pass `{ checkout }` to `createSessionRoutes` (Next.js) or `createSessionHandler` (Node).
3. **Show the member's own price:** on the course page, on the server, call `getMemberQuote`. Show its `totalMinor`. If `alreadyEnrolled` is true, show "You already have this course" instead of a button. A cached or static course page must never carry one member's price, as with the name in section 4: read it in the browser after the page loads, through your own same-origin route that calls `getMemberQuote` on your server and answers `Cache-Control: no-store`.
4. **Buy now, in the browser:** call `startMemberCheckout(offer, { csrf, expectedTotalMinor, paymentGateway, storageKey, coursePath })`, with the price the page showed as `expectedTotalMinor`.

Act on the result:

| Result | What the page does |
|---|---|
| `redirect` | Nothing. The browser is on its way to payment, then to your return page |
| `already-owned` | Show "You already have this course" |
| `fallback` with `price-changed` | Show the new price. The next click uses it |
| `fallback` with `signed-out`, `checkout-disabled`, `not-available` or `storage-unavailable` | Open your guest checkout pop-up |
| `fallback` with `refused` or `unavailable` | Say checkout isn't available for this course right now, or open your guest checkout |

The README's section 7 has every field and the record your return page reads.

## 7a. Verify the buyer's email before payment (v0.2.0)

A workspace can ask every self-serve buyer to prove their email before paying (`websiteCheckoutStatus.verifyEmail` is `"before-payment"`). Its guest checkout start is then refused, so your pop-up shows the code step instead.

The code step creates **no account and no session**. A right code gives your server a short-lived proof of the email. The kit keeps it in an HttpOnly cookie, and payment goes ahead against it. The account is made in the app after payment, when the buyer presses the thank-you button.

1. **Read the status** in the browser: `websiteCheckoutStatus { available verifyEmail }`. `verifyEmail` is the string `"off"` or `"before-payment"`.
2. **Off:** your pop-up is unchanged.
3. **On, signed in:** skip the code step and use member Buy Now (section 7).
4. **On, signed out:** email → code → payment. Use `useCodeStep({ offer, expectedTotalMinor, expectedCurrencyCode, country, workspaceName, storageKey, terms })` and draw the step with `CODE_STEP_COPY`. `expectedCurrencyCode` is that total's currency: the same number in another currency counts as a changed price, and it goes with every payment start. `expectedTotalMinor` is the guest total your pop-up showed, and `country` is the master-data country id (24 hex) it was priced in, such as the one the buyer picked. The kit sends it as the API's fallback country: a verified member is priced in their profile country first, and a changed total waits for "Pay {amount}". Without `country` the kit uses the `visitorCountry` setting's country. With neither, no code is sent: the start answers `COUNTRY_REQUIRED` (the error's `field` is `country`), so show your country picker and send again. `workspaceName` goes into "We couldn't take this payment. Try again, or contact {workspace}." After a reload with the code already right, the step resumes at "Pay {amount}" (step `resuming`, then `confirm-price`): draw `resuming` as a loading state.
5. **After the code** the kit re-quotes with the proof. The same total goes straight to payment ("Taking you to payment…"). A different total (a member's price) shows "Your member price is {amount}." and a "Pay {amount}" button (`step.priceLine`, `step.payLabel`, `step.pay()`).
6. **Return page:** on the server, `getCheckoutContinue(kit, { orderId })` answers the button for that order (only when this browser's proof started it, and drawn only when this tab holds the order's record), "Continue sign-up" (a new buyer) or "Go to my course" (a member), or `null` without a proof that is still good (or when the context read fails). Draw it with `<CheckoutContinueButton next={next} storageKey={...} />`. One press: the button asks the kit's server, which mints a one-time continue token (a 60-second nonce) at that moment (never on the page load), then sends the buyer on to the app with a form POST carrying it. The token never goes into an address, storage or a log, and the app asks "Continue as {email}" before signing in. If anything is wrong, the press opens the app's normal sign-in. When it is `null`, show your usual course link.

The code step's rules:

- The copy is fixed (signed). You may restyle it, but not reword it. That includes the terms tick box, "I agree to the {terms links}.", where you draw your links to the documents.
- One code input: spread `step.codeInputProps` on it. It has `autocomplete="one-time-code"` and `inputmode="numeric"` and no `maxLength`, so a pasted "123 456" becomes `123456`. Don't split it into one box per digit or catch Tab: Tab must leave the field.
- Focus moves to the code input when the step opens and after a wrong or expired code. With terms required and not ticked, focus moves to the tick box and the step stays usable.
- Tie errors to their inputs: the props carry `aria-invalid` and `aria-describedby` with `step.ids`; draw each message with the matching id. `state.error.field` says which input.
- Put `<CodeStepLiveRegion step={step} />` in the step and keep it mounted. It announces the countdown politely when it starts and when it is ready, never every second.
- On an expired code, "Send a new code" starts again with the email the step holds.
- Never put the proof or the continue nonce in an address, storage, analytics or a log. The page never sees the proof. The nonce reaches only the button's press handler, which posts it to the app at once.

## 8. Member event registration

A member signed in on your website registers for an event with one click, or answers only what their profile cannot, and sees "Registered" afterwards. A visitor who is not signed in keeps your guest form.

1. **On the server, make it once:** `createMemberEvents(kit)`.
2. **Read the member's seat after the page loads,** through your own same-origin route that calls `getMemberEvent` on your server and answers `Cache-Control: no-store` and `Vary: Cookie`. The event page itself stays the same for everyone, as with the name in section 4.
3. **Register** through the same route with `registerMemberEvent`, sending only what the member form asked.

Act on the result: `ok` shows the form or the registered panel; `signed-out`, `not-available` and a `NO_MEMBER_ROLE` refusal show your guest form; `ended` clears the cookie, then shows the guest form; `unavailable` says "Couldn't load your registration" with a Retry, never the guest form. The README's section 8 has every field and refusal.

## 9. Testing and fixtures

**Run the kit's tests:**

```sh
pnpm install
pnpm -r type-check && pnpm -r test && pnpm -r build
```

`packages/core/fixtures/saved-path.json` holds the cases for the `next` path rule: which paths are kept and which become `/`. If your site handles `next` itself anywhere, test it against the same cases.

**Run the example site on your machine:**

1. Copy `examples/next-site/.env.example` to `examples/next-site/.env.local` and fill it in with the test workspace's values.
2. Set `ZWINGD_SITE_ORIGIN=http://localhost:3100` and `ZWINGD_INSECURE_LOCAL_COOKIES=true`.
3. Ask the platform team to list `http://localhost:3100` for member sign-in on a **test workspace**, with its own client secret. Never use a live workspace's secret locally.
4. Run `pnpm --filter next-site dev` and open `http://localhost:3100`.

**Test checkout with test payments.** Ask the platform team which test workspace to use and how its payment provider is set up for test cards. Never test on a live workspace with a real card.

**Check these by hand before going live**, in a real browser:

- Log in, reload, see "My account"; sign out and land back on the same page.
- Sign out in the app, wait a minute, reload your website: "Log in" again.
- Guest checkout: a new email, an email that already has an account, and an email that already has the course.
- Cancel on the payment page, and close the tab after paying, then open the return page again.
- Website checkout switched off: "Buy now" falls back to the app's checkout.
- Member Buy Now, and a member who already owns the course.
- Every screen at 390 px wide, with the keyboard only.

## 10. Going live

1. Ask the workspace admin to add your live origins to **Allowed websites**, and the platform team to list them for member sign-in. Each origin gets its own client secret.
2. Put the live values in your hosting provider's server environment, marked secret where it can. Never commit them.
3. Deploy, then run the checks in section 9 on the live site with one real purchase the workspace can refund.
4. Look at **Your websites** in the workspace's settings: your site should show member sign-in set up and checkout allowed.

**What never to do:**

- Never put the client secret, a session token or an order token in a browser variable, an address, a log or your repository.
- Never show a sign-in form, or collect a password or a sign-in code, on your website.
- Never start a log-in on a page view. Only a click on "Log in" starts one.
- Never take a return address from the browser.
- Never charge a price your page did not show, and never work out a price or who may buy yourself.
- Never require a sign-in to buy.

## 11. Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| The site won't start: `WebsiteKitConfigError` naming a setting | That setting is missing or malformed | Check it against section 3. An origin must be exact: `https`, lower case, no path, no trailing slash |
| "Log in" comes back to your site, still signed out | The client secret is wrong, or was replaced and your server still has the old one | Check `ZWINGD_SESSION_CLIENT_SECRET`. Ask the platform team whether the secret was replaced and, if needed, for a new one |
| The browser stops on an app page instead of coming back | The app sends members back only to a listed origin, matched exactly. Your origin isn't listed for member sign-in, or `ZWINGD_SITE_ORIGIN` differs from the listed one (for example `www` against no `www`) | Check **Your websites**. Use the origin exactly as it was listed, or ask the platform team to list the other one too |
| Signed in, but "My account" doesn't show after a reload | The session cookie wasn't kept. Cookies are `Secure`, so they need HTTPS | Use HTTPS. For `http://localhost` only, set `ZWINGD_INSECURE_LOCAL_COOKIES=true` |
| Sign-out leaves "My account" showing | A cached page carries the member's name | Use client mode on cached pages (section 4) |
| A member signed in to the app isn't recognised on your website | Your website never checks quietly; a member is recognised only after pressing "Log in" | Expected. The member presses "Log in" once and comes straight back |
| **No sign-in code arrives** | Sign-in codes are limited per email. After several requests in a short time, no new code is sent, while the screen still says "If (email) can log in here, we've sent a code". The screen doesn't say more, on purpose, so it never tells anyone whether an account exists | Tell the member to wait a few minutes and check their spam folder before asking for a new code |
| "Buy now" opens the app instead of your pop-up | `websiteCheckoutStatus` answers not available | Ask the workspace admin to check **Allow website checkout**, **Who can buy** (anyone, with their email) and **Allowed websites** |
| The browser blocks your checkout calls (a CORS error) | Your origin isn't in **Allowed websites** | Ask the workspace admin to add it, exactly as your site's origin |
| A start is refused with `WEBSITE_CHECKOUT_DISABLED` | Website checkout is off for the workspace | Ask the workspace admin to switch on **Allow website checkout** |
| A start is refused with `HOSTED_CHECKOUT_OFF` | **How learners pay** isn't set to **In this app** | Ask the workspace admin to set it. The pop-up can open while this is wrong, so test a full start |
| The return page says it can't show the order | The order token isn't in this browser tab's `sessionStorage`: another browser, or a closed private window | Ask the buyer to open the page in the browser they paid in. The purchase still settles and the emails still go out |
| The price on your page and on the payment page differ | Your page shows a price it didn't get from the quote | Show the quote's price. For a member, pass the quote's `totalMinor` unchanged as `expectedTotalMinor` |
| Member Buy Now always falls back to the guest pop-up | The site is listed for member sign-in but not in **Allowed websites**, or website checkout is off | Check both lists in **Your websites** |
| Calls answer `rate_limited` or `unavailable` | Too many requests, or the API is busy | Keep the member signed in and try again later. The kit never signs a member out for these |

Still stuck? Send the platform team the time, your website's origin, the route or call, and the error word the API answered. Never send a secret, a token or a member's details.
