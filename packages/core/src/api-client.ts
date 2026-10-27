/**
 * The three server-to-server calls (session hand-over v1): exchange, session
 * and end, `POST <ZWINGD_API_URL>/api/external/session-handover/<call>` with the
 * client secret in `Authorization` only.
 *
 * Never throws. Each call answers `{ ok: true, body }` or `{ ok: false, error }`
 * where `error` is the contract's one word, `timeout` (treat as `unavailable`)
 * or `network`. Nothing here ever puts the secret, a token, a code or the
 * verifier into an error, and the API's own body is never echoed beyond its
 * known fields.
 */
import type { WebsiteKitConfig } from "./config.ts";

export const HANDOVER_ERRORS = ["invalid_request", "invalid_client", "invalid_grant", "rate_limited", "unavailable"] as const;
export type HandoverError = (typeof HANDOVER_ERRORS)[number];
export type CallFailure = HandoverError | "timeout" | "network";

export type CallResult<T> = { ok: true; body: T } | { ok: false; error: CallFailure; status?: number };

export interface HandoverMember {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  mobile?: string;
  mobileCountry?: string;
}

export interface ExchangeBody {
  sessionToken: string;
  expiresAt: string;
  member: HandoverMember;
}

export type SessionBody = { active: true; expiresAt: string; member: HandoverMember } | { active: false };

export interface EndBody {
  ended: true;
  appSignOutUrl: string | null;
  signOutTicket?: string;
}

const TOKEN = /^[0-9a-f]{64}$/;
const MEMBER_FIELDS = ["firstName", "lastName", "email", "mobile", "mobileCountry"] as const;

function member(value: unknown): HandoverMember | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  const out: HandoverMember = { id: raw.id };
  for (const key of MEMBER_FIELDS) if (typeof raw[key] === "string") out[key] = raw[key] as string;
  return out;
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function errorWord(status: number, body: unknown): HandoverError {
  const word = (body as { error?: unknown } | null)?.error;
  if (typeof word === "string" && (HANDOVER_ERRORS as readonly string[]).includes(word)) return word as HandoverError;
  if (status === 429) return "rate_limited";
  if (status === 401) return "invalid_client";
  if (status >= 500) return "unavailable";
  return "invalid_request";
}

async function post(config: WebsiteKitConfig, call: string, body: Record<string, string>): Promise<CallResult<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await config.fetch(`${config.apiUrl}/api/external/session-handover/${call}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.clientSecret}` },
      body: JSON.stringify({ realm: config.realm, origin: config.origin, ...body }),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (!res.ok) return { ok: false, error: errorWord(res.status, parsed), status: res.status };
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, error: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** Exchange a code for a website session. Call it ONCE per code: a second presentation ends the session the first created. */
export async function exchangeCode(config: WebsiteKitConfig, code: string, codeVerifier: string): Promise<CallResult<ExchangeBody>> {
  const res = await post(config, "exchange", { code, codeVerifier });
  if (!res.ok) return res;
  const raw = res.body as Record<string, unknown> | null;
  const m = member(raw?.member);
  if (!raw || typeof raw.sessionToken !== "string" || !TOKEN.test(raw.sessionToken) || !isTime(raw.expiresAt) || !m) {
    return { ok: false, error: "unavailable" };
  }
  return { ok: true, body: { sessionToken: raw.sessionToken, expiresAt: raw.expiresAt, member: m } };
}

/** Check a website session; `active: false` means drop it. */
export async function checkSession(config: WebsiteKitConfig, sessionToken: string): Promise<CallResult<SessionBody>> {
  const res = await post(config, "session", { sessionToken });
  if (!res.ok) return res;
  const raw = res.body as Record<string, unknown> | null;
  if (raw?.active === false) return { ok: true, body: { active: false } };
  const m = member(raw?.member);
  if (raw?.active !== true || !isTime(raw.expiresAt) || !m) return { ok: false, error: "unavailable" };
  return { ok: true, body: { active: true, expiresAt: raw.expiresAt, member: m } };
}

/** End a website session; safe to repeat. */
export async function endSession(config: WebsiteKitConfig, sessionToken: string): Promise<CallResult<EndBody>> {
  const res = await post(config, "end", { sessionToken });
  if (!res.ok) return res;
  const raw = res.body as Record<string, unknown> | null;
  const url = typeof raw?.appSignOutUrl === "string" ? raw.appSignOutUrl : null;
  return { ok: true, body: { ended: true, appSignOutUrl: url, ...(typeof raw?.signOutTicket === "string" ? { signOutTicket: raw.signOutTicket } : {}) } };
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}
