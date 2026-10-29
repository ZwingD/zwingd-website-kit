/**
 * Member events (B2 + B4, gateway `events/read` and `events/register`): a member
 * signed in on the website sees their own seat on an event and registers with
 * only the questions their profile cannot answer, with no name or email to type.
 *
 *   getMemberEvent(cookies, slug)               the member's seat and form, on the server
 *   registerMemberEvent(cookies, slug, input)   take the seat, on the server
 *
 * The website's server calls `POST <ZWINGD_API_URL>/api/external/session-handover/events/<call>`
 * with its client secret in `Authorization` and the session token from the
 * session cookie, as the member checkout does. The realm and origin are the
 * kit's own settings; the gateway reads both from the verified session, never
 * from the body. The browser never sends a token, a realm or a name.
 *
 * ⛔ A registration is never retried here: it takes a seat.
 * ⛔ The kit logs nothing, and nothing thrown or answered carries the client
 * secret, the session token or an answer.
 * ⛔ The answer is one member's own: serve it from a same-origin route with
 * `Cache-Control: no-store` and `Vary: Cookie`, never inside a cached page.
 */
import { eventsRead, eventsRegister, isSessionToken, type EventCallResult } from "./api-client.ts";
import type { WebsiteKit } from "./flows.ts";

/** How long the kit waits for the gateway: 10 s for a read, 15 s for a registration. */
export const MEMBER_EVENT_READ_TIMEOUT_MS = 10_000;
export const MEMBER_EVENT_REGISTER_TIMEOUT_MS = 15_000;

/** The member's seat on the event: null when they have none. */
export type MemberEventSeat = "REGISTERED" | "WAITLISTED";

/** A read refusal: the event is not one this member may see, or the member has no member role. */
export type MemberEventReadRefusal = "NOT_FOUND" | "NO_MEMBER_ROLE" | (string & {});
/** A registration refusal. `fields` names the questions an `ANSWER_INVALID` refers to. */
export type MemberEventRegisterRefusal =
  | "ALREADY_REGISTERED"
  | "ANSWER_INVALID"
  | "CONSENT_REQUIRED"
  | "FORM_CHANGED"
  | "CLOSED"
  | "NOT_FOUND"
  | "NO_MEMBER_ROLE"
  | (string & {});

/** One question of the member form, with the member's own profile value when it answers it. */
export interface MemberEventQuestion {
  key: string;
  type: string;
  label: string;
  required: boolean;
  helpText: string | null;
  placeholder: string | null;
  maxLength: number | null;
  options: Array<{ value: string; label: string; exclusive: boolean }>;
  signUpField: string | null;
  /** The member's profile answers this question: do not ask it and do not send it. Null: ask it. */
  viewerPrefill: { value: string; display: string } | null;
}

/** One consent. `labelHtml` is the workspace's own wording, sanitised by the platform. */
export interface MemberEventConsent {
  key: string;
  labelHtml: string;
  required: boolean;
  wordingVersion: string;
}

/** The member form (community's member projection). No name or email: they come from the account. */
export interface MemberEventForm {
  phone: "OPTIONAL" | "REQUIRED";
  questions: MemberEventQuestion[];
  consents: MemberEventConsent[];
  sensitiveRetentionDays: number | null;
}

export interface MemberEvent {
  id: string;
  viewerStatus: MemberEventSeat | null;
  ended: boolean;
  /** Null when nothing is asked (one-click register) or registration is not taken in-app now. */
  form: MemberEventForm | null;
}

/**
 * The read, as `getMemberQuote` answers it:
 *   - `ok`: the member's seat and form;
 *   - `signed-out`: no session cookie (the API is not asked);
 *   - `ended`: the API said the session is over: clear the session cookie (`kit.clearSessionCookie()`);
 *   - `refused`: `NOT_FOUND` (no such event for this workspace) or `NO_MEMBER_ROLE`;
 *   - `not-available`: this API has no member events (404);
 *   - `unavailable`: busy, down, rate limited (429), a timeout or a malformed answer;
 *   - `invalid-request`: the slug is malformed (the API is not asked).
 */
export type MemberEventCheck =
  | { status: "ok"; event: MemberEvent }
  | { status: "signed-out" }
  | { status: "ended" }
  | { status: "refused"; reason?: MemberEventReadRefusal }
  | { status: "not-available" }
  | { status: "unavailable" }
  | { status: "invalid-request" };

/** What the page sends: only what the member form asked. Name and email are never sent. */
export interface MemberEventRegistration {
  answers?: Array<{ key: string; value: string | string[] | boolean }>;
  consents?: Array<{ key: string; accepted: boolean; wordingVersion: string }>;
  phone?: string;
}

/** As `MemberEventCheck`, with the seat taken on `ok`. Never retried. */
export type MemberEventRegisterResult =
  | { status: "ok"; seat: MemberEventSeat }
  | { status: "signed-out" }
  | { status: "ended" }
  | { status: "refused"; reason?: MemberEventRegisterRefusal; fields?: string[] }
  | { status: "not-available" }
  | { status: "unavailable" }
  | { status: "invalid-request" };

export interface MemberEventsOptions {
  /** For tests: the call timeouts. Default 10 s and 15 s. */
  readTimeoutMs?: number;
  registerTimeoutMs?: number;
}

export interface MemberEvents {
  getMemberEvent(cookies: Record<string, string>, slug: string): Promise<MemberEventCheck>;
  registerMemberEvent(cookies: Record<string, string>, slug: string, registration?: MemberEventRegistration): Promise<MemberEventRegisterResult>;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MAX = 200;
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const PHONE = /^\+?[0-9 ()-]{6,32}$/;
const ANSWERS_MAX = 60;
const CONSENTS_MAX = 12;
const SEATS: readonly string[] = ["REGISTERED", "WAITLISTED"];

const isSlug = (value: unknown): value is string => typeof value === "string" && value.length <= SLUG_MAX && SLUG.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string";
const strOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

function question(raw: unknown): MemberEventQuestion | null {
  if (!isObject(raw)) return null;
  if (!str(raw.key) || !str(raw.type) || !str(raw.label) || typeof raw.required !== "boolean") return null;
  if (!strOrNull(raw.helpText) || !strOrNull(raw.placeholder) || !strOrNull(raw.signUpField)) return null;
  if (raw.maxLength !== null && typeof raw.maxLength !== "number") return null;
  if (!Array.isArray(raw.options)) return null;
  const options: MemberEventQuestion["options"] = [];
  for (const o of raw.options) {
    if (!isObject(o) || !str(o.value) || !str(o.label) || typeof o.exclusive !== "boolean") return null;
    options.push({ value: o.value, label: o.label, exclusive: o.exclusive });
  }
  const p = raw.viewerPrefill;
  if (p !== null && !(isObject(p) && str(p.value) && str(p.display))) return null;
  return {
    key: raw.key,
    type: raw.type,
    label: raw.label,
    required: raw.required,
    helpText: raw.helpText,
    placeholder: raw.placeholder,
    maxLength: raw.maxLength as number | null,
    options,
    signUpField: raw.signUpField,
    viewerPrefill: p === null ? null : { value: (p as { value: string }).value, display: (p as { display: string }).display },
  };
}

function form(raw: unknown): MemberEventForm | null | undefined {
  if (raw === null) return null;
  if (!isObject(raw) || (raw.phone !== "OPTIONAL" && raw.phone !== "REQUIRED")) return undefined;
  if (!Array.isArray(raw.questions) || !Array.isArray(raw.consents)) return undefined;
  if (raw.sensitiveRetentionDays !== null && typeof raw.sensitiveRetentionDays !== "number") return undefined;
  const questions: MemberEventQuestion[] = [];
  for (const q of raw.questions) {
    const parsed = question(q);
    if (!parsed) return undefined;
    questions.push(parsed);
  }
  const consents: MemberEventConsent[] = [];
  for (const c of raw.consents) {
    if (!isObject(c) || !str(c.key) || !str(c.labelHtml) || typeof c.required !== "boolean" || !str(c.wordingVersion)) return undefined;
    consents.push({ key: c.key, labelHtml: c.labelHtml, required: c.required, wordingVersion: c.wordingVersion });
  }
  return { phone: raw.phone, questions, consents, sensitiveRetentionDays: raw.sensitiveRetentionDays as number | null };
}

/** The contract's `event`, keeping its fields only; null when it does not have the shape. */
function memberEvent(raw: unknown): MemberEvent | null {
  if (!isObject(raw) || !str(raw.id) || raw.id === "" || typeof raw.ended !== "boolean") return null;
  const seat = raw.viewerStatus;
  if (seat !== null && !(str(seat) && SEATS.includes(seat))) return null;
  const f = form(raw.form);
  if (f === undefined) return null;
  return { id: raw.id, viewerStatus: seat as MemberEventSeat | null, ended: raw.ended, form: f };
}

/** The registration the page asked for, keeping the contract's fields only; null when malformed. */
function registrationOf(input: unknown): MemberEventRegistration | null {
  if (input === undefined) return {};
  if (!isObject(input)) return null;
  const out: MemberEventRegistration = {};
  if (input.answers !== undefined) {
    if (!Array.isArray(input.answers) || input.answers.length > ANSWERS_MAX) return null;
    const answers: NonNullable<MemberEventRegistration["answers"]> = [];
    for (const a of input.answers) {
      if (!isObject(a) || !str(a.key) || !KEY.test(a.key)) return null;
      const v = a.value;
      if (!(str(v) || typeof v === "boolean" || (Array.isArray(v) && v.every(str)))) return null;
      answers.push({ key: a.key, value: Array.isArray(v) ? [...v] : v });
    }
    out.answers = answers;
  }
  if (input.consents !== undefined) {
    if (!Array.isArray(input.consents) || input.consents.length > CONSENTS_MAX) return null;
    const consents: NonNullable<MemberEventRegistration["consents"]> = [];
    for (const c of input.consents) {
      if (!isObject(c) || !str(c.key) || !KEY.test(c.key) || typeof c.accepted !== "boolean") return null;
      if (!str(c.wordingVersion) || c.wordingVersion.length < 1 || c.wordingVersion.length > 64) return null;
      consents.push({ key: c.key, accepted: c.accepted, wordingVersion: c.wordingVersion });
    }
    out.consents = consents;
  }
  if (input.phone !== undefined) {
    if (!str(input.phone) || !PHONE.test(input.phone)) return null;
    out.phone = input.phone;
  }
  return out;
}

export function createMemberEvents(kit: WebsiteKit, options: MemberEventsOptions = {}): MemberEvents {
  const { config, cookieNames: names } = kit;
  const readMs = options.readTimeoutMs ?? MEMBER_EVENT_READ_TIMEOUT_MS;
  const registerMs = options.registerTimeoutMs ?? MEMBER_EVENT_REGISTER_TIMEOUT_MS;

  /** A failed call as the page's answer; `ended` drops the cached session check. */
  async function failure(res: EventCallResult<unknown> & { ok: false }, token: string) {
    if (res.error === "ended") {
      await kit.forget(token);
      return { status: "ended" as const };
    }
    if (res.error === "not_available") return { status: "not-available" as const };
    if (res.error === "refused") return { status: "refused" as const, ...(res.reason ? { reason: res.reason } : {}), ...(res.fields ? { fields: res.fields } : {}) };
    return { status: "unavailable" as const };
  }

  async function getMemberEvent(cookies: Record<string, string>, slug: string): Promise<MemberEventCheck> {
    if (!isSlug(slug)) return { status: "invalid-request" };
    const token = cookies[names.session];
    if (!isSessionToken(token)) return { status: "signed-out" };
    const res = await eventsRead(config, token, slug, readMs);
    if (!res.ok) {
      const answer = await failure(res, token);
      // A read refusal names no fields.
      if (answer.status === "refused") return { status: "refused", ...(answer.reason ? { reason: answer.reason } : {}) };
      return answer;
    }
    const event = memberEvent(res.body.event);
    return event ? { status: "ok", event } : { status: "unavailable" };
  }

  async function registerMemberEvent(
    cookies: Record<string, string>,
    slug: string,
    registration?: MemberEventRegistration
  ): Promise<MemberEventRegisterResult> {
    const body = registrationOf(registration);
    if (!isSlug(slug) || !body) return { status: "invalid-request" };
    const token = cookies[names.session];
    if (!isSessionToken(token)) return { status: "signed-out" };
    // ONE registration. Whatever it answers, it is not sent again.
    const res = await eventsRegister(config, token, { slug, ...body }, registerMs);
    if (!res.ok) return failure(res, token);
    const seat = res.body.seat;
    return str(seat) && SEATS.includes(seat) ? { status: "ok", seat: seat as MemberEventSeat } : { status: "unavailable" };
  }

  return { getMemberEvent, registerMemberEvent };
}
