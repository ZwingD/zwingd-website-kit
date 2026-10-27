"use client";
/**
 * Hands the member summary to Client Components. The browser gets the name
 * (and the sign-out form value) only, never a token, email or phone.
 *
 * Two ways to feed it:
 *
 *   // Server-fed, for dynamic pages (app/layout.tsx, a Server Component)
 *   <MemberProvider member={await getMember(kit)} signOutToken={await signOutToken(kit)} appUrl={process.env.ZWINGD_APP_URL!}>
 *
 *   // Client mode, for cached or static pages: reads GET /session/me once on mount
 *   <MemberProvider mode="client" appUrl={process.env.ZWINGD_APP_URL!}>
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { SiteMember } from "./server.ts";
import { readSessionMe, SESSION_ME_PATH } from "./session-me.ts";

export interface MemberState {
  member: SiteMember | null;
  signOutToken: string | null;
  /** The workspace's app address, for "Go to my account". */
  appUrl: string;
  /** True while client mode has not heard back from /session/me yet. */
  loading: boolean;
}

const MemberContext = createContext<MemberState>({ member: null, signOutToken: null, appUrl: "", loading: false });

export type MemberProviderProps =
  | { mode?: "server"; member: SiteMember | null; signOutToken: string | null; appUrl: string; children: ReactNode }
  | { mode: "client"; appUrl: string; children: ReactNode };

function ClientMemberProvider({ appUrl, children }: { appUrl: string; children: ReactNode }) {
  const [state, setState] = useState<MemberState>({ member: null, signOutToken: null, appUrl, loading: true });
  useEffect(() => {
    let live = true;
    fetch(SESSION_ME_PATH, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => {
        if (live) setState({ ...readSessionMe(data), appUrl, loading: false });
      });
    return () => {
      live = false;
    };
  }, [appUrl]);
  return <MemberContext.Provider value={state}>{children}</MemberContext.Provider>;
}

export function MemberProvider(props: MemberProviderProps) {
  if (props.mode === "client") return <ClientMemberProvider appUrl={props.appUrl}>{props.children}</ClientMemberProvider>;
  const { member, signOutToken, appUrl, children } = props;
  return <MemberContext.Provider value={{ member, signOutToken, appUrl, loading: false }}>{children}</MemberContext.Provider>;
}

/** The member summary from the nearest `MemberProvider`, or null when nobody is signed in (or not known yet). */
export function useMember(): SiteMember | null {
  return useContext(MemberContext).member;
}

export function useMemberState(): MemberState {
  return useContext(MemberContext);
}
