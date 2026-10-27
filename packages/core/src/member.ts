/**
 * Who is signed in (session hand-over v1, "Re-checking a session").
 *   - A check result is cached for at most 60 seconds, keyed by sha256 of the
 *     token (the cache never holds a token).
 *   - The session is dropped ONLY on `active: false`. A 429, a 503, a timeout
 *     or a network fault keeps it: the member stays signed in, with the name
 *     from the last good check if there is one.
 *   - Contact details (email, mobile) are answered only from a check under 60
 *     seconds old; `fresh` skips the cache, for a checkout prefill.
 */
import { checkSession, type HandoverMember, isSessionToken } from "./api-client.ts";
import type { WebsiteKitConfig } from "./config.ts";
import type { CookieNames } from "./cookies.ts";
import { sha256Hex } from "./pkce.ts";

export const CHECK_CACHE_MS = 60_000;
export const CHECK_CACHE_MAX_ENTRIES = 5_000;

export interface MemberSummary {
  id: string;
  firstName?: string;
  lastName?: string;
}

export interface MemberContact {
  email?: string;
  mobile?: string;
  mobileCountry?: string;
}

export type MemberCheck =
  /** No session cookie (or not a session token): nobody is signed in on this website. */
  | { status: "signed-out" }
  /** The API answered `active: false`: the site must clear its session cookie. */
  | { status: "ended" }
  | {
      status: "signed-in";
      /** From the last good check; null when no check has succeeded yet in this process. */
      member: MemberSummary | null;
      /** Only from a check under 60 seconds old, else null. */
      contact: MemberContact | null;
      /** True when this answer comes from a check under 60 seconds old. */
      fresh: boolean;
      /** When that check ran (ms), or null. */
      checkedAt: number | null;
    };

interface Entry {
  member: HandoverMember;
  checkedAt: number;
}

function summaryOf(m: HandoverMember): MemberSummary {
  return { id: m.id, ...(m.firstName ? { firstName: m.firstName } : {}), ...(m.lastName ? { lastName: m.lastName } : {}) };
}

function contactOf(m: HandoverMember): MemberContact {
  return {
    ...(m.email ? { email: m.email } : {}),
    ...(m.mobile ? { mobile: m.mobile } : {}),
    ...(m.mobileCountry ? { mobileCountry: m.mobileCountry } : {}),
  };
}

export interface MemberReader {
  /** The member behind the session cookie, from the cache when it is under 60 s old. */
  getMember(cookies: Record<string, string>): Promise<MemberCheck>;
  /** The same, always asking the API first (before showing a checkout prefill). */
  freshMember(cookies: Record<string, string>): Promise<MemberCheck>;
  /** Record a member just returned by an exchange, so the first page after sign-in needs no check. */
  remember(sessionToken: string, member: HandoverMember): Promise<void>;
  /** Drop a token's cached check (sign-out). */
  forget(sessionToken: string): Promise<void>;
}

export function createMemberReader(config: WebsiteKitConfig, names: CookieNames): MemberReader {
  const cache = new Map<string, Entry>();

  const store = (key: string, entry: Entry) => {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CHECK_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const signedIn = (entry: Entry | undefined, fresh: boolean): MemberCheck => ({
    status: "signed-in",
    member: entry ? summaryOf(entry.member) : null,
    contact: entry && fresh ? contactOf(entry.member) : null,
    fresh,
    checkedAt: entry?.checkedAt ?? null,
  });

  async function read(cookies: Record<string, string>, skipCache: boolean): Promise<MemberCheck> {
    const token = cookies[names.session];
    if (!isSessionToken(token)) return { status: "signed-out" };
    const key = await sha256Hex(token);
    const cached = cache.get(key);
    if (!skipCache && cached && config.now() - cached.checkedAt < CHECK_CACHE_MS) return signedIn(cached, true);

    const res = await checkSession(config, token);
    if (res.ok && res.body.active) {
      const entry = { member: res.body.member, checkedAt: config.now() };
      store(key, entry);
      return signedIn(entry, true);
    }
    if (res.ok) {
      cache.delete(key);
      return { status: "ended" };
    }
    // 429, 503, a timeout, a network fault, even invalid_client: keep the session.
    return signedIn(cached, false);
  }

  return {
    getMember: (cookies) => read(cookies, false),
    freshMember: (cookies) => read(cookies, true),
    async remember(sessionToken, member) {
      if (isSessionToken(sessionToken)) store(await sha256Hex(sessionToken), { member, checkedAt: config.now() });
    },
    async forget(sessionToken) {
      if (isSessionToken(sessionToken)) cache.delete(await sha256Hex(sessionToken));
    },
  };
}
