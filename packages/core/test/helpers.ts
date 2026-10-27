/** Test helpers: a fake API that records every call, and request views. */
import type { RequestView } from "../src/flows.ts";

export const ORIGIN = "https://www.example.org";
export const APP = "https://app.example.org";
export const API = "https://api.example.com";
export const SECRET = "zsh_" + "a".repeat(64);
export const TOKEN = "9b2e4d6f8a0c1e3f5a7b9d0c2e4f6a8b0d1e3f5a7c9b0d2e4f6a8c0b1d3e5f7a";
export const CODE = "3f9a1c0b5d7e2a4c6b8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d";

export interface RecordedCall {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

export type Reply = { status: number; body?: unknown } | "timeout" | "network";

/** A fetch that answers each call from `replies[call]` (exchange / session / end) and records it. */
export function fakeApi(replies: Partial<Record<"exchange" | "session" | "end", Reply | Reply[]>>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    const call = url.slice(url.lastIndexOf("/") + 1) as "exchange" | "session" | "end";
    const configured = replies[call];
    const reply = Array.isArray(configured) ? configured[calls.filter((c) => c.url.endsWith(`/${call}`)).length - 1] : configured;
    if (reply === undefined) throw new Error(`no reply configured for ${call}`);
    if (reply === "network") throw new TypeError("fetch failed");
    if (reply === "timeout") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

export function req(over: Partial<RequestView> & { url: string }): RequestView {
  return { method: "GET", cookies: {}, headers: {}, ...over };
}

/** Cookies as a browser would send them back from a list of Set-Cookie values (name=value only, removals dropped). */
export function jar(setCookies: string[], into: Record<string, string> = {}): Record<string, string> {
  const out = { ...into };
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq);
    const value = pair!.slice(eq + 1);
    if (/Max-Age=0/.test(line)) delete out[name];
    else out[name] = value;
  }
  return out;
}

export const cookieNamed = (setCookies: string[], name: string) => setCookies.find((line) => line.startsWith(`${name}=`));
