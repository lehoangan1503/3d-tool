/**
 * RunPod Serverless worker loop.
 *
 * NOTE: RunPod's official serverless *worker* SDK is Python-only — the npm
 * `runpod-sdk` package is a CLIENT for calling endpoints, not a worker host.
 * This file implements the queue protocol directly:
 *   1. GETs   /job-take/{workerId}   to receive a job (long-poll),
 *   2. POSTs  /job-done/{workerId}?id={jobId}   with the result.
 *
 * !! UNVERIFIED AGAINST A LIVE ENDPOINT !!
 * RunPod publishes no public spec for non-Python workers (checked
 * docs.runpod.io/serverless/workers/* and llms.txt — only the Python SDK path
 * is documented), so the variable names and paths below are inferred, not a
 * documented contract. If they are wrong the worker still functions: it falls
 * through to the single-job branch in main(), renders the job it was given and
 * exits. What is lost is queue draining, not correctness.
 *
 * For a first deployment prefer WORKER_MODE=serve (serve.mjs): a plain HTTP
 * endpoint the app already knows how to poke, with no guessed protocol. Switch
 * here only after confirming these variables actually appear in a pod's env
 * (Console -> Endpoint -> Workers -> Logs shows the startup dump below).
 *
 * Billing runs while the container is alive, so the loop exits after an idle
 * stretch and lets the endpoint scale to zero.
 */

import { handler as renderHandler } from "./worker.mjs";

const WORKER_ID = process.env.RUNPOD_POD_ID ?? process.env.HOSTNAME ?? "worker";
const API_KEY = process.env.RUNPOD_AI_API_KEY ?? "";
/** Injected by the platform; e.g. https://api.runpod.ai/v2/<endpointId> */
const BASE = (process.env.RUNPOD_WEBHOOK_GET_JOB ?? "").replace(/\/job-take.*$/, "");
/** Exit after this long with no job so the pod stops billing. */
const IDLE_EXIT_MS = Number(process.env.RUNPOD_IDLE_EXIT_MS ?? 60_000);

function log(...args) {
  console.log("[runpod]", ...args);
}

function authHeaders() {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
}

/** Long-polls for one job. Returns null when the poll times out empty. */
async function takeJob() {
  const url =
    process.env.RUNPOD_WEBHOOK_GET_JOB?.replace("$ID", WORKER_ID) ??
    `${BASE}/job-take/${WORKER_ID}`;

  const res = await fetch(url, { method: "GET", headers: authHeaders() });

  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`job-take failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function reportDone(jobId, payload) {
  const url =
    process.env.RUNPOD_WEBHOOK_POST_OUTPUT?.replace("$ID", jobId) ??
    `${BASE}/job-done/${WORKER_ID}?id=${encodeURIComponent(jobId)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    log(`job-done failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

async function main() {
  if (!API_KEY || !process.env.RUNPOD_WEBHOOK_GET_JOB) {
    // Not on RunPod (or the injected variable names differ from what this file
    // guesses): run one job and exit. Log every RUNPOD_* variable the platform
    // actually set, so a single look at the pod log tells us the real names
    // instead of leaving the protocol a guess.
    const seen = Object.keys(process.env).filter((k) => k.startsWith("RUNPOD_"));
    log(
      seen.length > 0
        ? `RunPod queue vars not as expected. RUNPOD_* present: ${seen.join(", ")}`
        : "no RunPod env detected (running standalone)"
    );

    const jobId = process.argv[2];
    log(`running single job ${jobId ?? "(from queue)"}`);
    const summary = await renderHandler({ jobId });
    log("summary:", JSON.stringify(summary));
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  log(`worker ${WORKER_ID} polling for jobs`);
  let lastJobAt = Date.now();

  for (;;) {
    let job = null;
    try {
      job = await takeJob();
    } catch (error) {
      log("take failed:", error.message);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    if (!job) {
      if (Date.now() - lastJobAt > IDLE_EXIT_MS) {
        log("idle — exiting so the pod scales to zero");
        return;
      }
      continue;
    }

    lastJobAt = Date.now();
    const input = job.input ?? {};
    log(`job ${job.id} received:`, JSON.stringify(input));

    try {
      const summary = await renderHandler(input);
      // A failed RENDER is a legitimate outcome, not an infra fault: report it
      // as output so RunPod does not retry work the app already marked
      // 'failed' with a real reason.
      await reportDone(job.id, { output: { ...summary, ok: summary.failed === 0 } });
    } catch (error) {
      log(`job ${job.id} crashed:`, error.message);
      // Genuine infra faults (no GPU, Chrome refused to start, missing env)
      // belong in `error` so the platform can retry on another pod.
      await reportDone(job.id, { error: String(error.message ?? error) });
    }
  }
}

main().catch((error) => {
  log("fatal:", error);
  process.exit(1);
});
