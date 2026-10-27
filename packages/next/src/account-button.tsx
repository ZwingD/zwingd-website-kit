"use client";
/**
 * "Log in" or "My account" for the header. Unstyled: every element it draws
 * takes its own class name, so the site's own look stays its own (Iris on
 * KIT-2): the loading placeholder, the Log in link, the My account trigger,
 * the menu, each menu item, and the sign-out form and its button. A part with
 * no name of its own falls back to `className` (root parts) or `itemClassName`
 * (the sign-out button), as before.
 *
 * In client mode, a "Log in" shown because /session/me timed out or failed
 * asks again on the visitor's focus or click (`retry`), never on a timer.
 *
 *   - Signed out: a link to `/session/start?next=<this page>`. Only a click
 *     starts a hand-over; a page view never does.
 *   - Signed in: "My account" opens a menu (`<details>`, works without
 *     JavaScript) with "Go to my account" (a full navigation to the app) and
 *     "Sign out" (a form POST to `/session/end` carrying the csrf value).
 */
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { useMemberState } from "./member-provider.tsx";

export interface AccountButtonLabels {
  logIn: string;
  myAccount: string;
  goToMyAccount: string;
  signOut: string;
}

export const DEFAULT_ACCOUNT_LABELS: AccountButtonLabels = {
  logIn: "Log in",
  myAccount: "My account",
  goToMyAccount: "Go to my account",
  signOut: "Sign out",
};

export interface AccountButtonProps {
  labels?: Partial<AccountButtonLabels>;
  /** Where to come back to after logging in; default: the current page. */
  next?: string;
  /** The root of each state: the `<details>` when signed in; also the Log in link and the placeholder unless they have their own. */
  className?: string;
  /** The empty placeholder while client mode waits for /session/me. */
  loadingClassName?: string;
  /** The "Log in" link. */
  logInClassName?: string;
  /** The "My account" trigger (`<summary>`). */
  triggerClassName?: string;
  /** The menu that opens under it. */
  menuClassName?: string;
  /** Each menu item ("Go to my account", and "Sign out" unless signOutClassName is set). */
  itemClassName?: string;
  /** The sign-out `<form>`. */
  signOutFormClassName?: string;
  /** The "Sign out" button. */
  signOutClassName?: string;
}

export function AccountButton(props: AccountButtonProps) {
  const { member, signOutToken, appUrl, loading, retry } = useMemberState();
  // The path only: useSearchParams would force a Suspense boundary around every
  // header. A page that needs its query back passes `next`.
  const pathname = usePathname();
  const labels = { ...DEFAULT_ACCOUNT_LABELS, ...props.labels };
  const trigger = useRef<HTMLElement>(null);
  // kit #5 (Iris): a retry started from "Log in" that turns it into "My account"
  // hands focus to "My account", so a keyboard user is not left on a removed element.
  const refocus = useRef(false);
  const retryFromLogIn = () => {
    refocus.current = true;
    retry();
  };
  useEffect(() => {
    if (!member || !refocus.current) return;
    refocus.current = false;
    // Only when focus was lost with the removed link: never take it from where the visitor moved on to.
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (!active || active === document.body || !active.isConnected) trigger.current?.focus();
  }, [member]);

  // Client mode, before /session/me answers: an empty element of the same
  // class keeps the header's layout, so "Log in" never flashes for a member.
  if (loading) return <span className={props.loadingClassName ?? props.className} aria-busy="true" />;

  if (!member) {
    const next = props.next ?? pathname ?? "/";
    return (
      <a className={props.logInClassName ?? props.className} href={`/session/start?next=${encodeURIComponent(next)}`} onFocus={retryFromLogIn} onClick={retryFromLogIn}>
        {labels.logIn}
      </a>
    );
  }

  return (
    <details className={props.className}>
      <summary ref={trigger} className={props.triggerClassName}>
        {labels.myAccount}
      </summary>
      <div className={props.menuClassName}>
        <a className={props.itemClassName} href={`${appUrl}/`}>
          {labels.goToMyAccount}
        </a>
        {signOutToken ? (
          <form className={props.signOutFormClassName} method="post" action="/session/end">
            <input type="hidden" name="csrf" value={signOutToken} />
            <button className={props.signOutClassName ?? props.itemClassName} type="submit">
              {labels.signOut}
            </button>
          </form>
        ) : null}
      </div>
    </details>
  );
}
