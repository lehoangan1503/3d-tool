/**
 * Wakes a rented GPU worker for a queued job.
 *
 * The VPS running this app has no usable GPU, so it never renders. It only
 * pokes a serverless GPU endpoint, which cold-starts a container, claims the
 * job from Postgres, renders, and posts results back. Billing is per second of
 * actual render time — the endpoint scales to zero in between.
 *
 * Dispatch is intentionally FIRE-AND-FORGET-ish: if the poke fails, the job
 * stays 'queued' and any worker that later polls will pick it up. That keeps a
 * provider outage from losing work.
 */

import type { RenderWorkerProvider } from "@/types/render-job";

export interface DispatchResult {
  provider: RenderWorkerProvider;
  /** The provider's own job/run id, when it returns one. */
  workerJobId: string | null;
  dispatched: boolean;
  error?: string;
}

interface RunPodRunResponse {
  id?: string;
  status?: string;
  error?: string;
}

interface BeamRunResponse {
  task_id?: string;
  id?: string;
  error?: string;
}

interface ModalRunResponse {
  call_id?: string;
  error?: string;
}

/**
 * What the worker needs to fetch its own job. The job payload itself is NOT
 * sent over the wire — it can be tens of MB of frames — the worker reads it
 * from Postgres with the service key it already holds.
 */
export interface DispatchInput {
  jobId: string;
  kind: "image" | "video";
  /** Absolute base URL of this app, so the worker can open the render page. */
  appBaseUrl: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

export function configuredProvider(): RenderWorkerProvider {
  const raw = (process.env.RENDER_GPU_PROVIDER ?? "runpod").toLowerCase();
  if (raw === "beam" || raw === "modal" || raw === "local") return raw;
  return "runpod";
}

/**
 * True when a GPU backend is actually wired up. When false the API still
 * enqueues jobs (so nothing is lost) but tells the caller no worker will pick
 * them up until the env is configured.
 */
export function isGpuConfigured(): boolean {
  switch (configuredProvider()) {
    case "runpod":
      return Boolean(process.env.RUNPOD_API_KEY && process.env.RUNPOD_ENDPOINT_ID);
    case "beam":
      return Boolean(process.env.BEAM_TOKEN && process.env.BEAM_ENDPOINT_URL);
    case "modal":
      return Boolean(process.env.MODAL_ENDPOINT_URL);
    case "local":
      return Boolean(process.env.LOCAL_RENDER_WORKER_URL);
  }
}

const DISPATCH_TIMEOUT_MS = 15_000;

async function postJson<T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** RunPod Serverless: POST /v2/{endpointId}/run — async, returns a run id. */
async function dispatchRunPod(input: DispatchInput): Promise<DispatchResult> {
  const apiKey = requiredEnv("RUNPOD_API_KEY");
  const endpointId = requiredEnv("RUNPOD_ENDPOINT_ID");
  const base = process.env.RUNPOD_API_BASE ?? "https://api.runpod.ai";

  const data = await postJson<RunPodRunResponse>(
    `${base}/v2/${endpointId}/run`,
    { Authorization: `Bearer ${apiKey}` },
    { input: { jobId: input.jobId, kind: input.kind, appBaseUrl: input.appBaseUrl } }
  );

  return { provider: "runpod", workerJobId: data.id ?? null, dispatched: true };
}

/** Beam: POST the deployment URL directly. */
async function dispatchBeam(input: DispatchInput): Promise<DispatchResult> {
  const token = requiredEnv("BEAM_TOKEN");
  const url = requiredEnv("BEAM_ENDPOINT_URL");

  const data = await postJson<BeamRunResponse>(
    url,
    { Authorization: `Bearer ${token}` },
    { jobId: input.jobId, kind: input.kind, appBaseUrl: input.appBaseUrl }
  );

  return {
    provider: "beam",
    workerJobId: data.task_id ?? data.id ?? null,
    dispatched: true,
  };
}

/** Modal: a web endpoint on the deployed function. */
async function dispatchModal(input: DispatchInput): Promise<DispatchResult> {
  const url = requiredEnv("MODAL_ENDPOINT_URL");
  const token = process.env.MODAL_TOKEN;

  const data = await postJson<ModalRunResponse>(
    url,
    token ? { Authorization: `Bearer ${token}` } : {},
    { jobId: input.jobId, kind: input.kind, appBaseUrl: input.appBaseUrl }
  );

  return { provider: "modal", workerJobId: data.call_id ?? null, dispatched: true };
}

/** A worker running on the operator's own machine during development. */
async function dispatchLocal(input: DispatchInput): Promise<DispatchResult> {
  const url = requiredEnv("LOCAL_RENDER_WORKER_URL");
  await postJson<Record<string, unknown>>(url, {}, {
    jobId: input.jobId,
    kind: input.kind,
    appBaseUrl: input.appBaseUrl,
  });
  return { provider: "local", workerJobId: null, dispatched: true };
}

/**
 * Pokes the configured GPU backend. Never throws: a failed poke leaves the job
 * queued for the next polling worker, and the reason is returned for logging.
 */
export async function dispatchRenderJob(input: DispatchInput): Promise<DispatchResult> {
  const provider = configuredProvider();

  if (!isGpuConfigured()) {
    return {
      provider,
      workerJobId: null,
      dispatched: false,
      error: `GPU provider "${provider}" is not configured — job stays queued`,
    };
  }

  try {
    switch (provider) {
      case "runpod": return await dispatchRunPod(input);
      case "beam":   return await dispatchBeam(input);
      case "modal":  return await dispatchModal(input);
      case "local":  return await dispatchLocal(input);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[render] dispatch to ${provider} failed:`, message);
    return { provider, workerJobId: null, dispatched: false, error: message };
  }
}

/**
 * Public base URL the GPU container should open. The container is outside the
 * VPS network, so localhost / internal IPs are never valid here.
 */
export function resolveAppBaseUrl(request: Request): string {
  const configured = process.env.RENDER_APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, "");

  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const host = forwardedHost ?? url.host;
  const proto = forwardedProto ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
