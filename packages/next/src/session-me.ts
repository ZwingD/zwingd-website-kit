/**
 * The browser side of GET /session/me: where it is, and how its answer is
 * read. Anything unexpected reads as signed out, never as a member.
 *
 * The read gives up after SESSION_ME_TIMEOUT_MS and answers signed out, so a
 * hung API never leaves the header empty (Iris on KIT-2). Such an answer is
 * `retryable`: the reader asks again only when `retry()` is called, which the
 * header does on the visitor's next focus or click on "Log in". Never on a timer.
 */
import type { SiteMember } from "./server.ts";

export const SESSION_ME_PATH = "/session/me";

export function readSessionMe(data: unknown): { member: SiteMember | null; signOutToken: string | null } {
  const body = (data && typeof data === "object" ? data : {}) as { member?: unknown; signOutToken?: unknown };
  const m = body.member && typeof body.member === "object" ? (body.member as Record<string, unknown>) : null;
  if (!m) return { member: null, signOutToken: null };
  return {
    member: {
      ...(typeof m.firstName === "string" ? { firstName: m.firstName } : {}),
      ...(typeof m.lastName === "string" ? { lastName: m.lastName } : {}),
    },
    signOutToken: typeof body.signOutToken === "string" ? body.signOutToken : null,
  };
}

/** About 5 s: after it the header shows "Log in" rather than nothing. */
export const SESSION_ME_TIMEOUT_MS = 5_000;

export interface SessionMeRead {
  member: SiteMember | null;
  signOutToken: string | null;
  /** True when the read did not get a real answer (a timeout, a fault): the next user action may ask again. */
  retryable: boolean;
}

export interface SessionMeReader {
  /** The first read (on mount). */
  read(): Promise<SessionMeRead>;
  /** Ask again after a read that got no real answer; null (and no request) otherwise. Shares a read in flight. */
  retry(): Promise<SessionMeRead> | null;
}

const SIGNED_OUT_RETRYABLE: SessionMeRead = { member: null, signOutToken: null, retryable: true };

export function createSessionMeReader(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): SessionMeReader {
  const timeoutMs = options.timeoutMs ?? SESSION_ME_TIMEOUT_MS;
  let inFlight: Promise<SessionMeRead> | null = null;
  let last: SessionMeRead | null = null;

  async function once(): Promise<SessionMeRead> {
    const controller = new AbortController();
    // The only timer: it ends THIS request. Nothing is ever re-asked from a timer.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const fetchImpl = options.fetch ?? globalThis.fetch;
      const res = await fetchImpl(SESSION_ME_PATH, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return SIGNED_OUT_RETRYABLE;
      return { ...readSessionMe(await res.json()), retryable: false };
    } catch {
      return SIGNED_OUT_RETRYABLE;
    } finally {
      clearTimeout(timer);
    }
  }

  function start(): Promise<SessionMeRead> {
    if (!inFlight) {
      inFlight = once().then((result) => {
        last = result;
        inFlight = null;
        return result;
      });
    }
    return inFlight;
  }

  return {
    read: start,
    retry() {
      if (inFlight) return inFlight;
      if (!last || !last.retryable) return null;
      return start();
    },
  };
}
