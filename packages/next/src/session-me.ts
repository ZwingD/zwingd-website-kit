/**
 * The browser side of GET /session/me: where it is, and how its answer is
 * read. Anything unexpected reads as signed out, never as a member.
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
