// Copy this file: it serves GET /session/start, GET /session/callback and POST /session/end.
import { createSessionRoutes } from "@zwingd-ce/website-kit-next";

import { zwingd } from "@/lib/zwingd";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return createSessionRoutes(zwingd()).GET(request);
}

export function POST(request: Request) {
  return createSessionRoutes(zwingd()).POST(request);
}
