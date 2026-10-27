// kit #10: the app's sign-out returns the member to "/"; this sends them on to the
// page they signed out from. Only "/" is matched, so no other page pays for it.
// Next 16 calls this file proxy.ts; on Next 15 name it middleware.ts and export `middleware`.
import { signOutReturn } from "@zwingd-ce/website-kit-next";

import { zwingd } from "@/lib/zwingd";

export function proxy(request: Request) {
  return signOutReturn(zwingd(), request);
}

export const config = { matcher: "/" };
