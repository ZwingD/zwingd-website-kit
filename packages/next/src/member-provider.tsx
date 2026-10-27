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
 *
 * Client mode gives up after about 5 s and shows "Log in"; it asks again only
 * on the visitor's next focus or click on the button (`retry`), never on a timer.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { SiteMember } from "./server.ts";
import { createSessionMeReader, type SessionMeReader } from "./session-me.ts";

export interface MemberState {
  member: SiteMember | null;
  signOutToken: string | null;
  /** The workspace's app address, for "Go to my account". */
  appUrl: string;
  /** True while client mode has not heard back from /session/me yet. */
  loading: boolean;
  /**
   * Client mode after a read that got no real answer: ask /session/me again.
   * Called by AccountButton on the visitor's focus or click; does nothing otherwise.
   */
  retry: () => void;
}

const noop = () => undefined;
const MemberContext = createContext<MemberState>({ member: null, signOutToken: null, appUrl: "", loading: false, retry: noop });

export type MemberProviderProps =
  | { mode?: "server"; member: SiteMember | null; signOutToken: string | null; appUrl: string; children: ReactNode }
  | { mode: "client"; appUrl: string; children: ReactNode };

function ClientMemberProvider({ appUrl, children }: { appUrl: string; children: ReactNode }) {
  const reader = useRef<SessionMeReader | null>(null);
  const live = useRef(true);
  const [read, setRead] = useState<{ member: MemberState["member"]; signOutToken: string | null; loading: boolean }>({
    member: null,
    signOutToken: null,
    loading: true,
  });

  useEffect(() => {
    live.current = true;
    reader.current = createSessionMeReader();
    void reader.current.read().then(({ member, signOutToken }) => {
      if (live.current) setRead({ member, signOutToken, loading: false });
    });
    return () => {
      live.current = false;
    };
  }, [appUrl]);

  // Only a user action calls this: a read that timed out or failed is asked again once.
  const retry = useCallback(() => {
    const again = reader.current?.retry();
    void again?.then(({ member, signOutToken }) => {
      if (live.current) setRead({ member, signOutToken, loading: false });
    });
  }, []);

  return <MemberContext.Provider value={{ ...read, appUrl, retry }}>{children}</MemberContext.Provider>;
}

export function MemberProvider(props: MemberProviderProps) {
  if (props.mode === "client") return <ClientMemberProvider appUrl={props.appUrl}>{props.children}</ClientMemberProvider>;
  const { member, signOutToken, appUrl, children } = props;
  return <MemberContext.Provider value={{ member, signOutToken, appUrl, loading: false, retry: noop }}>{children}</MemberContext.Provider>;
}

/** The member summary from the nearest `MemberProvider`, or null when nobody is signed in (or not known yet). */
export function useMember(): SiteMember | null {
  return useContext(MemberContext).member;
}

export function useMemberState(): MemberState {
  return useContext(MemberContext);
}
