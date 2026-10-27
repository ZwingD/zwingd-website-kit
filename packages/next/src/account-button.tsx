"use client";
/**
 * "Log in" or "My account" for the header. Unstyled: every element takes a
 * `className` hook, so the site's own look stays its own.
 *
 *   - Signed out: a link to `/session/start?next=<this page>`. Only a click
 *     starts a hand-over; a page view never does.
 *   - Signed in: "My account" opens a menu (`<details>`, works without
 *     JavaScript) with "Go to my account" (a full navigation to the app) and
 *     "Sign out" (a form POST to `/session/end` carrying the csrf value).
 */
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
  className?: string;
  menuClassName?: string;
  itemClassName?: string;
}

export function AccountButton(props: AccountButtonProps) {
  const { member, signOutToken, appUrl } = useMemberState();
  // The path only: useSearchParams would force a Suspense boundary around every
  // header. A page that needs its query back passes `next`.
  const pathname = usePathname();
  const labels = { ...DEFAULT_ACCOUNT_LABELS, ...props.labels };

  if (!member) {
    const next = props.next ?? pathname ?? "/";
    return (
      <a className={props.className} href={`/session/start?next=${encodeURIComponent(next)}`}>
        {labels.logIn}
      </a>
    );
  }

  return (
    <details className={props.className}>
      <summary>{labels.myAccount}</summary>
      <div className={props.menuClassName}>
        <a className={props.itemClassName} href={`${appUrl}/`}>
          {labels.goToMyAccount}
        </a>
        {signOutToken ? (
          <form method="post" action="/session/end">
            <input type="hidden" name="csrf" value={signOutToken} />
            <button className={props.itemClassName} type="submit">
              {labels.signOut}
            </button>
          </form>
        ) : null}
      </div>
    </details>
  );
}
