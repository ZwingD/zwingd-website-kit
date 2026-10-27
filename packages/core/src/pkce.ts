/**
 * The random values of a hand-over start (session hand-over v1, "GET
 * /session/start"): `state` and the PKCE verifier, from the alphabet
 * `A-Z a-z 0-9 - . _ ~`, and the S256 challenge. Web Crypto only, so the core
 * runs on Node 18.17+ and edge runtimes alike.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
// 66 symbols: bytes at or above 264 (4 x 66) are drawn again, so every symbol is equally likely.
const ACCEPT_BELOW = 256 - (256 % ALPHABET.length);

export const STATE_LENGTH = 43;
export const VERIFIER_LENGTH = 64;
export const STATE_PATTERN = /^[A-Za-z0-9\-._~]{16,512}$/;
export const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

function webCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c?.getRandomValues || !c.subtle) throw new Error("Zwingd website kit: Web Crypto is not available");
  return c;
}

/** `length` characters of the contract's alphabet, from a cryptographic source. */
export function randomToken(length: number): string {
  const c = webCrypto();
  let out = "";
  while (out.length < length) {
    const bytes = c.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < ACCEPT_BELOW) out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `base64url(sha256(verifier))` without padding: the S256 `code_challenge`. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await webCrypto().subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Hex sha256, for keys that must not hold the value itself (the check cache). */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await webCrypto().subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
