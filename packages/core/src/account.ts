/**
 * Where "Go to my account" and a course link open in the workspace's app
 * (kit #11, operator decision 2026-10-28: per workspace, never one client's rule).
 *
 *   - The account path is the kit's `accountPath` setting when the site gives
 *     one, else the WORKSPACE's own landing path (`signInOptions.landingPath`,
 *     identity's public read: no token, the realm header names the workspace),
 *     else `/`. Read on the server, cached about 5 minutes; any failure is `/`.
 *   - A course link is `coursePath` with the course code in it when the site
 *     gives one, else the member's learning page (`/communities/learning`).
 *
 * Both are full addresses in the app (`<ZWINGD_APP_URL><path>`), opened with a
 * plain link: the member is signed in to the app already.
 */
import type { WebsiteKitConfig } from "./config.ts";
import { savedPath } from "./saved-path.ts";

/** How long a workspace's landing path is kept. */
export const LANDING_PATH_CACHE_MS = 5 * 60 * 1000;
/** A failed read is not asked again for this long (the link is `/` meanwhile). */
export const LANDING_PATH_FAILURE_CACHE_MS = 30 * 1000;
/** The read's own timeout: a slow API never holds a page for long. */
export const LANDING_PATH_TIMEOUT_MS = 3_000;
/** Where a course link goes when the site names no course page (Helm, 2026-10-28). */
export const LEARNING_PATH = "/communities/learning";

const LANDING_QUERY = "query signInOptions { signInOptions { landingPath } }";
// Course codes are letters, digits, `-` and `_` (e.g. `CRS-1234`).
const COURSE_CODE = /^[A-Za-z0-9_-]{1,128}$/;

/** A path the saved-path rule keeps exactly, else `/`. */
function inAppPath(raw: unknown): string {
  return typeof raw === "string" ? savedPath(raw) : "/";
}

/**
 * A course page in the app, for the browser or the server: `coursePath` with
 * `:code` replaced when both are usable, else the learning page.
 */
export function courseUrlFor(appUrl: string, code: unknown, coursePath?: string | null): string {
  const base = appUrl.replace(/\/+$/, "");
  if (typeof coursePath === "string" && coursePath.includes(":code") && savedPath(coursePath) === coursePath && typeof code === "string" && COURSE_CODE.test(code)) {
    return `${base}${coursePath.replace(":code", encodeURIComponent(code))}`;
  }
  return `${base}${LEARNING_PATH}`;
}

export interface AccountLinks {
  /** The path "Go to my account" opens: the setting, else the workspace's landing path, else `/`. Never throws. */
  accountPath(): Promise<string>;
  /** `<ZWINGD_APP_URL><accountPath>`. */
  accountUrl(): Promise<string>;
  /** `<ZWINGD_APP_URL>` + the course page, or the learning page. */
  courseUrl(code: string): string;
}

export function createAccountLinks(config: WebsiteKitConfig): AccountLinks {
  let cached: { path: string; until: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function readLandingPath(): Promise<{ path: string; ok: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(LANDING_PATH_TIMEOUT_MS, config.timeoutMs));
    try {
      const res = await config.fetch(`${config.apiUrl}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", realm: config.realm },
        body: JSON.stringify({ query: LANDING_QUERY }),
        signal: controller.signal,
      });
      if (!res.ok) return { path: "/", ok: false };
      const body = (await res.json()) as { data?: { signInOptions?: { landingPath?: unknown } | null } | null };
      const options = body?.data?.signInOptions;
      if (!options || typeof options !== "object") return { path: "/", ok: false };
      // null = the app's own landing: `/`.
      return { path: options.landingPath == null ? "/" : inAppPath(options.landingPath), ok: true };
    } catch {
      return { path: "/", ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async function accountPath(): Promise<string> {
    if (config.accountPath) return config.accountPath;
    const now = config.now();
    if (cached && now < cached.until) return cached.path;
    if (!inFlight) {
      inFlight = readLandingPath().then(({ path, ok }) => {
        cached = { path, until: config.now() + (ok ? LANDING_PATH_CACHE_MS : LANDING_PATH_FAILURE_CACHE_MS) };
        inFlight = null;
        return path;
      });
    }
    return inFlight;
  }

  return {
    accountPath,
    async accountUrl() {
      const path = await accountPath();
      return `${config.appUrl}${path}`;
    },
    courseUrl(code: string) {
      return courseUrlFor(config.appUrl, code, config.coursePath);
    },
  };
}
