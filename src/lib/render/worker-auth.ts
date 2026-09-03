/**
 * Authenticates the GPU worker.
 *
 * The worker is a container on a rented card — it has no Supabase user and no
 * cookie. It authenticates with a shared secret in the Authorization header,
 * and every route it touches uses the service client (RLS-exempt) because it
 * legitimately acts on other users' jobs.
 *
 * Keep RENDER_WORKER_SECRET out of anything NEXT_PUBLIC_: leaking it would let
 * anyone claim jobs and post arbitrary output URLs onto them.
 */

import { NextResponse } from "next/server";
import { createAdminServiceClient } from "@/lib/supabase/server";
import {
  asRenderStorageClient,
  type RenderStorageClient,
} from "@/lib/render/supabase-surface";

/** Constant-time compare, so a wrong secret leaks nothing through timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface WorkerContext {
  admin: RenderStorageClient;
  /** Free-form worker id (pod id / hostname) for tracing which card ran what. */
  workerId: string;
}

export function requireWorker(
  request: Request
): { ok: true; ctx: WorkerContext } | { ok: false; response: NextResponse } {
  const secret = process.env.RENDER_WORKER_SECRET;

  if (!secret) {
    // Failing closed matters here: without a secret, an open claim endpoint
    // would hand out every user's job payload.
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Worker API disabled — RENDER_WORKER_SECRET is not set" },
        { status: 503 }
      ),
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!provided || !safeEqual(provided, secret)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized worker" }, { status: 401 }),
    };
  }

  return {
    ok: true,
    ctx: {
      admin: asRenderStorageClient(createAdminServiceClient()),
      workerId: request.headers.get("x-worker-id") ?? "unknown",
    },
  };
}
