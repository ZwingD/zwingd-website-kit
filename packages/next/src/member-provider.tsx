"use client";
/**
 * Hands the member summary to Client Components. The browser gets the name
 * (and the sign-out form value) only, never a token, email or phone.
 *
 * Two ways to feed it:
 *
 *   // Server-fed, for dynamic pages (app/layout.tsx, a Server Component)
 *   <MemberProvider member={await getMember(kit)} signOutToken={await signOutToken(kit)}
 *     appUrl={kit.config.appUrl} accountUrl={await accountUrl(kit)} coursePath={kit.config.coursePath}>
 *
 *   // Client mode, for cached or static pages: reads GET /session/me once on mount
 *   // (its answer carries accountUrl)
 *   <MemberProvider mode="client" appUrl={process.env.ZWINGD_APP_URL!} coursePath="/communities/courses/:code">
 *
 * Client mode gives up after about 5 s and shows "Log in"; it asks again only
 * on the visitor's next focus or click on the button (`retry`), never on a timer.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { courseUrlFor } from "@zwingd-ce/website-kit";

import type { SiteMember } from "./server.ts";
import { createSessionMeReader, type SessionMeReader } from "./session-me.ts";

export interface MemberState {
  member: SiteMember | null;
  signOutToken: string | null;
  /** The workspace's app address. */
  appUrl: string;
  /**
   * Where "Go to my account" opens (kit #11): the workspace's landing path, or
   * the site's `accountPath`. Null when not known: the app's home.
   */
  accountUrl: string | null;
  /** kit #11: the app's page for one course by code, or the member's learning page. */
  courseUrl: (code: string) => string;
  /** True while client mode has not heard back from /session/me yet. */
  loading: boolean;
  /**
   * Client mode after a read that got no real answer: ask /session/me again.
   * Called by AccountButton on the visitor's focus or click; does nothing otherwise.
   */
  retry: () => void;
}

const noop = () => undefined;
const MemberContext = createContext<MemberState>({
  member: null,
  signOutToken: null,
  appUrl: "",
  accountUrl: null,
  courseUrl: () => "",
  loading: false,
  retry: noop,
});

interface LinkProps {
  /** The app's page for one course, with `:code` in it (the kit's `coursePath`); without it course links open the learning page. */
  coursePath?: string | null;
}

export type MemberProviderProps =
  | ({
      mode?: "server";
      member: SiteMember | null;
      signOutToken: string | null;
      appUrl: string;
      /** `await accountUrl(kit)` from `@zwingd-ce/website-kit-next/server`. Without it: the app's home. */
      accountUrl?: string | null;
      children: ReactNode;
    } & LinkProps)
  | ({ mode: "client"; appUrl: string; children: ReactNode } & LinkProps);

function ClientMemberProvider({ appUrl, coursePath, children }: { appUrl: string; coursePath?: string | null; children: ReactNode }) {
  const reader = useRef<SessionMeReader | null>(null);
  const live = useRef(true);
  const [read, setRead] = useState<{ member: MemberState["member"]; signOutToken: string | null; accountUrl: string | null; loading: boolean }>({
    member: null,
    signOutToken: null,
    accountUrl: null,
    loading: true,
  });

  useEffect(() => {
    live.current = true;
    reader.current = createSessionMeReader();
    void reader.current.read().then(({ member, signOutToken, accountUrl }) => {
      if (live.current) setRead({ member, signOutToken, accountUrl, loading: false });
    });
    return () => {
      live.current = false;
    };
  }, [appUrl]);

  // Only a user action calls this: a read that timed out or failed is asked again once.
  const retry = useCallback(() => {
    const again = reader.current?.retry();
    void again?.then(({ member, signOutToken, accountUrl }) => {
      if (live.current) setRead({ member, signOutToken, accountUrl, loading: false });
    });
  }, []);

  const courseUrl = (code: string) => courseUrlFor(appUrl, code, coursePath);
  return <MemberContext.Provider value={{ ...read, appUrl, courseUrl, retry }}>{children}</MemberContext.Provider>;
}

export function MemberProvider(props: MemberProviderProps) {
  if (props.mode === "client") {
    return (
      <ClientMemberProvider appUrl={props.appUrl} coursePath={props.coursePath}>
        {props.children}
      </ClientMemberProvider>
    );
  }
  const { member, signOutToken, appUrl, children } = props;
  const accountUrl = props.accountUrl ?? null;
  const courseUrl = (code: string) => courseUrlFor(appUrl, code, props.coursePath);
  return <MemberContext.Provider value={{ member, signOutToken, appUrl, accountUrl, courseUrl, loading: false, retry: noop }}>{children}</MemberContext.Provider>;
}

/** The member summary from the nearest `MemberProvider`, or null when nobody is signed in (or not known yet). */
export function useMember(): SiteMember | null {
  return useContext(MemberContext).member;
}

/** kit #11: `(code) => url` of the app's page for one course (the owned-course panel's "Go to my course"). */
export function useCourseUrl(): (code: string) => string {
  return useContext(MemberContext).courseUrl;
}

export function useMemberState(): MemberState {
  return useContext(MemberContext);
}
