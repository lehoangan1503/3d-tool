import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     * - api/v1 (bearer-token API, see below)
     *
     * /api/v1/* is excluded because its callers are external and carry no
     * Supabase cookie: the middleware's session refresh would spend a network
     * round-trip on every request to resolve a session that cannot exist. Those
     * routes authenticate themselves via requireApiToken(), so nothing is
     * skipped by leaving them out — and no middleware rule redirects /api/*
     * anyway, so this is purely about not paying for the lookup.
     */
    "/((?!api/v1|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|glb)$).*)",
  ],
};
