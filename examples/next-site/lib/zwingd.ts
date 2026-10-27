// Copy this file. Server code only: it holds the client secret.
import { configFromEnv, createWebsiteKit, type WebsiteKit } from "@zwingd-ce/website-kit-next";

let kit: WebsiteKit | null = null;

/**
 * The site's kit, made on first use so `next build` does not need the secret.
 * A missing or bad setting throws once, naming the setting, never its value.
 */
export function zwingd(): WebsiteKit {
  if (!kit) {
    kit = createWebsiteKit(
      configFromEnv(process.env, { insecureLocalCookies: process.env.ZWINGD_INSECURE_LOCAL_COOKIES === "true" }),
    );
  }
  return kit;
}
