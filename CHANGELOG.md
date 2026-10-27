# Changelog

## 0.1.0 (unreleased)

- `@zwingd-ce/website-kit`: the session hand-over v1 website contract as pure functions. It covers the `/session/start`, `/session/callback`, `/session/end` and `/session/me` flows (the last a same-origin JSON read of who is signed in), the saved-path rule with the contract's fixtures, PKCE S256, the three cookies, the exchange / session / end calls, and `getMember` with a 60 s check cache (ZwingD/zwingd-backend#1869).
- `@zwingd-ce/website-kit-node`: `createSessionHandler` for Express and Node http, plus `getMember`, `freshMember` and `signOutFormToken` for server-rendered pages.
- `@zwingd-ce/website-kit-next`: `createSessionRoutes` for the App Router; `getMember`, `getCheckoutMember` and `signOutToken` for Server Components; `MemberProvider` (server-fed, or `mode="client"` reading `/session/me`), `useMember` and an unstyled `AccountButton`.
