/**
 * HTTP front door for the render worker.
 *
 * Used by Beam, Modal, and any always-on GPU box (and by `RENDER_GPU_PROVIDER=local`
 * during development). RunPod Serverless does not need this — it polls its own
 * queue via runpod-handler.mjs.
 *
 * POST /  { jobId, kind }   → renders, responds with the summary
 * GET  /health              → readiness probe
 *
 * Requests are authenticated with the same RENDER_WORKER_SECRET the app uses,
 * so an exposed GPU box cannot be driven by strangers.
 */

import { createServer } from "node:http";
import { handler as renderHandler } from "./worker.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.RENDER_WORKER_SECRET ?? "";
/** One render at a time: a second concurrent job would fight for VRAM. */
let busy = false;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorized(req) {
  if (!SECRET) return false;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${SECRET}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      return send(res, 200, { ok: true, busy });
    }

    if (req.method !== "POST") {
      return send(res, 405, { error: "Method not allowed" });
    }
    if (!authorized(req)) {
      return send(res, 401, { error: "Unauthorized" });
    }
    if (busy) {
      // Tell the caller to retry rather than thrashing VRAM. The job stays
      // queued either way, so nothing is lost.
      return send(res, 429, { error: "Worker busy", retry: true });
    }

    let input;
    try {
      input = await readJson(req);
    } catch {
      return send(res, 400, { error: "Invalid JSON body" });
    }

    busy = true;
    try {
      const summary = await renderHandler(input);
      send(res, 200, { ...summary, ok: summary.failed === 0 });
    } catch (error) {
      console.error("[serve] render crashed:", error);
      send(res, 500, { error: String(error?.message ?? error) });
    } finally {
      busy = false;
    }
  })();
});

server.listen(PORT, () => {
  console.log(`[serve] render worker listening on :${PORT}`);
});
