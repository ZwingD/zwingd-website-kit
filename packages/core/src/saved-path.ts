/**
 * The saved path (session hand-over v1, "The saved path"): the website's own
 * `next` parameter is a same-origin path, or it is `/`. Applied to the value
 * the query parser gives, after its one decoding; never decoded again.
 */

export const SAVED_PATH_MAX = 512;

// Code 0 to 31 or 127: browsers drop tabs and line breaks from a URL, so
// `/<tab>/evil.example` would become `//evil.example`.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The path to send the visitor back to: `raw` when it passes the rule, else `/`. */
export function savedPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (raw.length === 0 || raw.length > SAVED_PATH_MAX) return "/";
  if (raw[0] !== "/" || raw[1] === "/") return "/";
  if (raw.includes("\\") || CONTROL.test(raw)) return "/";
  return raw;
}
