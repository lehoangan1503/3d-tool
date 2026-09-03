# GPU render worker

Renders cue mockups (2D image groups) and studio videos on a **rented GPU**,
instead of on the operator's browser.

## Why it works this way

The render engine (`src/lib/three/*`, ~250KB) is browser code: WebGL,
`document.createElement("canvas")`, `new Image()`, and for video
`canvas.captureStream()` + `MediaRecorder`. None of that exists in Node, so the
engine cannot be imported into an API route.

Instead, a **headless Chrome running on a GPU** opens a normal page of this app
(`/render-worker`) and runs the same functions the deploy dialog runs. The
output is therefore pixel-identical to what the operator previews, and the
engine is untouched.

The VPS hosting the app needs no GPU: it only writes a job row and pokes this
worker.

```
browser ──POST /api/products/<id>/renders──► VPS (no GPU)
                                              │ insert render_jobs row
                                              │ poke GPU endpoint
                                              ▼
                                       rented GPU container
                                       headless Chrome opens
                                       /render-worker?jobId=…
                                              │ claim → render → upload
                                              ▼
                                       Supabase Storage + job row
browser ──GET /api/render-jobs/<jobId>──► progress, then output URLs
```

## Modes

One image, three front doors — `WORKER_MODE` (default `auto`):

| Mode | Used by | Entry |
|---|---|---|
| `runpod` | RunPod Serverless | polls RunPod's own queue |
| `serve` | Beam, Modal, any always-on GPU box | HTTP `POST /` on `$PORT` |
| `job` | local testing, one-shot | renders one job and exits |

`auto` picks `runpod` when RunPod's env is present, else `serve` when `$PORT` is
set, else `job`.

## Build & run

```bash
# build
docker build -t cue-render-worker ./render-worker

# run locally against a dev server (needs a GPU + nvidia runtime for real speed)
docker run --rm --gpus all --shm-size=2g \
  -e APP_BASE_URL=https://your-app.example.com \
  -e RENDER_WORKER_SECRET=<same secret as the app> \
  cue-render-worker <jobId>
```

`--shm-size=2g` is not optional: Chrome's default 64MB of shared memory makes it
crash part-way through a 2048×2048 render.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `APP_BASE_URL` | yes | Public URL of the app. The container is outside the VPS network, so an internal IP will not work. |
| `RENDER_WORKER_SECRET` | yes | Shared secret; must match the app's. Never expose it as `NEXT_PUBLIC_*`. |
| `RENDER_ANGLE_BACKEND` | no | ANGLE backend. Defaults to `gl` on Linux, `default` elsewhere. See "GPU gotchas". |
| `RENDER_MAX_JOBS_PER_RUN` | no | Ceiling on jobs drained per cold start (default 5). Only fires when the queue is deeper than the pool of pods; extra jobs are whatever is oldest in the queue, **not** the same product. Images: 5–8. Video: 2–3. |
| `RENDER_RUN_BUDGET_MS` | recommended | Wall-clock budget for the whole pod — set it to the provider's execution timeout. The worker then refuses a new job it may not finish, instead of being killed mid-render (which strands that job until its lease expires). Default 0 = disabled. |
| `RENDER_JOB_TIMEOUT_MS` | no | Per-job ceiling (default 20 min). |
| `WORKER_MODE` | no | `auto` \| `runpod` \| `serve` \| `job`. |
| `PORT` | serve mode | HTTP port (default 8080). |
| `USE_XVFB` | no | `1` (default) wraps Chrome in Xvfb. |

## GPU gotchas

These are the failures that cost money rather than announce themselves:

1. **Software fallback.** Without `--enable-gpu --ignore-gpu-blocklist`, Chrome
   disables the GPU in a container and silently uses SwiftShader (CPU). Renders
   still succeed, 10–50× slower — GPU rates for CPU speed. The worker logs the
   WebGL renderer string at launch; if it says `SwiftShader` or `llvmpipe`, the
   card is not being used.

2. **`--use-angle=gl` is not portable.** On Linux + NVIDIA it is the backend
   that reaches the driver. On macOS there is no desktop-GL backend and the same
   flag makes `getContext("webgl")` return `null`, so *nothing* renders
   (verified: it kills WebGL on an M1, while the platform default gives hardware
   Metal). Hence `RENDER_ANGLE_BACKEND`, plus a verified launch that retries on
   the platform default and refuses to start if WebGL is missing entirely.

3. **`NVIDIA_DRIVER_CAPABILITIES` must include `graphics`.** With only
   `compute,utility` — the common default — the GL/EGL user space is never
   mounted into the container and WebGL has no driver to talk to. The Dockerfile
   sets `compute,utility,graphics,display`.

4. **CUDA `runtime` base, not `base`.** The `base` image lacks the GL libraries
   ANGLE needs.

5. **Missing fonts.** Any text drawn into a mockup renders as boxes without
   `fonts-noto-*`. Easy to miss until a customer sees it.

## Provider notes

`RENDER_GPU_PROVIDER` on the **app** side selects who gets poked:

- **RunPod Serverless** — per-second billing, scale-to-zero. The best default
  for bursty renders. Note: RunPod's serverless *worker* SDK is Python-only;
  the npm `runpod-sdk` is a client, so `runpod-handler.mjs` implements the
  worker protocol directly (`job-take` / `job-done`).
- **Beam / Modal** — per-second, scale-to-zero, HTTP front door → `serve` mode.
- **SaladCloud / Vast.ai** — cheapest per hour, but consumer GPUs on shared
  hosts with long cold starts; poor fit while a user waits on a render.
- **`local`** — a worker on your own machine, for development.

## Cost shape

The cold start (image pull, Chrome launch, GLB + HDRI download) dominates a
single mockup, so a warm card drains up to `RENDER_MAX_JOBS_PER_RUN` more jobs
before exiting.

Two things this is NOT:

- **Not a batching plan.** Draining only happens when the queue is deeper than
  the endpoint's pool of pods. With `Max Workers` >= the number of products
  usually queued, every job gets its own pod and the cap never fires.
- **Not per-product.** A drained job is whatever is oldest in the queue
  (`WHERE status='queued' ORDER BY created_at`) — any product, any user.

Why the cap exists: VRAM is not fully reclaimed between jobs, so late jobs in a
long-lived pod crash more often; and the provider's execution timeout applies to
the whole pod, so 5 video jobs at ~6 min each overrun a 20-minute limit and the
pod is killed mid-render. `RENDER_RUN_BUDGET_MS` enforces that arithmetic rather
than leaving it to the operator.

Queueing several products at once is still much cheaper per image — but because
the provider starts several pods in parallel, not because one pod batches them.
