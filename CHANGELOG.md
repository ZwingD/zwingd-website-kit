# Changelog

## 0.1.0 (unreleased)

- `@zwingd-ce/website-kit`: the session hand-over v1 website contract as pure functions. It covers the `/session/start`, `/session/callback`, `/session/end` and `/session/me` flows (the last a same-origin JSON read of who is signed in), the saved-path rule with the contract's fixtures, PKCE S256, the three cookies, the exchange / session / end calls, and `getMember` with a 60 s check cache (ZwingD/zwingd-backend#1869).
- `@zwingd-ce/website-kit-node`: `createSessionHandler` for Express and Node http, plus `getMember`, `freshMember` and `signOutFormToken` for server-rendered pages.
- `@zwingd-ce/website-kit-next`: `createSessionRoutes` for the App Router; `getMember`, `getCheckoutMember` and `signOutToken` for Server Components; `MemberProvider` (server-fed, or `mode="client"` reading `/session/me`), `useMember` and an unstyled `AccountButton`.
- Member checkout (session hand-over v1.1, ZwingD/zwingd-backend#1869): `createMemberCheckout` serves `POST /session/checkout` and `getMemberQuote` from the site's server, with `startMemberCheckout` for the browser. `createSessionHandler` (Node) and `createSessionRoutes` (Next) serve the route when given a checkout; `getMemberQuote` is also on `@zwingd-ce/website-kit-next/server`.
- One same-site POST rule, `sameSitePost`, behind both `/session/end` and `/session/checkout`.
- `AccountButton` takes a class name on every part it draws (`loadingClassName`, `logInClassName`, `triggerClassName`, `signOutFormClassName`, `signOutClassName` added).
- Client mode's `/session/me` read gives up after about 5 s and shows "Log in"; it asks again on the next focus or click on the button, never on a timer.
