// Copy this file: it serves GET /session/start, GET /session/callback, POST /session/end,
// GET /session/me and (member checkout) POST /session/checkout.
import { createSessionRoutes } from "@zwingd-ce/website-kit-next";

import { memberCheckout, zwingd } from "@/lib/zwingd";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return createSessionRoutes(zwingd(), { checkout: memberCheckout() }).GET(request);
}

export function POST(request: Request) {
  return createSessionRoutes(zwingd(), { checkout: memberCheckout() }).POST(request);
}
