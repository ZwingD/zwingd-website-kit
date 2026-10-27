"use client";
/**
 * Hands the server's member summary to Client Components. The browser gets
 * the name (and the sign-out form value) only, never a token, email or phone.
 *
 *   // app/layout.tsx (a Server Component)
 *   <MemberProvider member={await getMember(kit)} signOutToken={await signOutToken(kit)} appUrl={process.env.ZWINGD_APP_URL!}>
 */
import { createContext, useContext, type ReactNode } from "react";

import type { SiteMember } from "./server.ts";

export interface MemberState {
  member: SiteMember | null;
  signOutToken: string | null;
  /** The workspace's app address, for "Go to my account". */
  appUrl: string;
}

const MemberContext = createContext<MemberState>({ member: null, signOutToken: null, appUrl: "" });

export function MemberProvider(props: MemberState & { children: ReactNode }) {
  const { children, ...state } = props;
  return <MemberContext.Provider value={state}>{children}</MemberContext.Provider>;
}

/** The member summary from the nearest `MemberProvider`, or null when nobody is signed in. */
export function useMember(): SiteMember | null {
  return useContext(MemberContext).member;
}

export function useMemberState(): MemberState {
  return useContext(MemberContext);
}
