/**
 * GPU render worker.
 *
 * Runs inside a container on a RENTED GPU (RunPod Serverless / Beam / Modal).
 * The web app itself lives on a plain VPS with no usable GPU, so it never
 * renders — it only queues jobs and pokes this worker.
 *
 * Why a headless browser and not plain Node + three.js:
 * the render engine in src/lib/three is ~250KB of browser code. It calls
 * document.createElement("canvas"), new Image(), WebGL, and — for video —
 * canvas.captureStream() + MediaRecorder. None of that exists in Node. Porting
 * it would mean rewriting the recorder around ffmpeg and re-verifying every
 * frame, with a real risk that server renders stop matching what the operator
 * sees in the browser. Running the SAME code inside Chrome, on a GPU, keeps the
 * output pixel-identical and the engine untouched.
 *
 * Flow per job:
 *   1. open  {APP_BASE_URL}/render-worker?jobId=…&token=…
 *   2. the page claims the job, renders, uploads each file, marks it done
 *   3. we wait for window.__renderWorkerResult and exit
 *
 * The GPU is billed per second, so the worker drains the queue while the card
 * is warm (a cold start costs far more than one extra job) and then exits.
 */

// puppeteer-core, not puppeteer: the image already installs Chromium via apt,
// and the bundled download would add ~400MB and a second, unused browser.
import puppeteer from "puppeteer-core";

const APP_BASE_URL = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
const WORKER_SECRET = process.env.RENDER_WORKER_SECRET ?? "";
const WORKER_ID = process.env.RUNPOD_POD_ID ?? process.env.HOSTNAME ?? "worker";
const PROVIDER = process.env.RENDER_GPU_PROVIDER ?? "runpod";

/** A single mockup can take ~30s; a long video studio path far more. */
const JOB_TIMEOUT_MS = Number(process.env.RENDER_JOB_TIMEOUT_MS ?? 20 * 60 * 1000);
/**
 * Ceiling on jobs drained per cold start.
 *
 * This is a SAFETY CAP, not a plan to batch work: jobs 2..N are only taken when
 * the queue still has more jobs than the endpoint has pods. With Max Workers
 * >= the number of products usually queued, each job gets its own pod and this
 * never fires.
 *
 * Why cap it at all — three real pressures, all pushing down:
 *  1. VRAM is not fully reclaimed between jobs (Chrome + driver hold on to
 *     some), so late jobs in a long-lived pod crash more often than early ones.
 *  2. The provider's execution timeout applies to the WHOLE pod, not per job.
 *     Draining past it gets the pod killed mid-render.
 *  3. A crash only strands the job in flight, but that job then waits out its
 *     full lease before another pod retries it.
 * Against that, a warm card skips the ~45s cold start, which is the single
 * most expensive part of one mockup.
 *
 * Video jobs are minutes each: 5 of them exceed a 20-minute timeout, so lower
 * this (2-3) on a video-heavy endpoint. RENDER_RUN_BUDGET_MS enforces it
 * regardless.
 */
const MAX_JOBS_PER_RUN = Number(process.env.RENDER_MAX_JOBS_PER_RUN ?? 5);

/**
 * Wall-clock budget for the whole pod, mirroring the provider's execution
 * timeout. The worker stops taking NEW jobs once the remaining budget cannot
 * fit another one, so it exits cleanly instead of being killed mid-render —
 * a kill leaves the job stranded until its lease expires, which the user
 * experiences as a render that hangs.
 *
 * Defaults to 0 (disabled) because only the operator knows what the endpoint
 * is configured with. Set it to the endpoint's execution timeout.
 */
const RUN_BUDGET_MS = Number(process.env.RENDER_RUN_BUDGET_MS ?? 0);
/** Chrome executable — the base image ships one. */
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/chromium";

function log(...args) {
  console.log(`[worker ${WORKER_ID}]`, ...args);
}

function assertEnv() {
  const missing = [];
  if (!APP_BASE_URL) missing.push("APP_BASE_URL");
  if (!WORKER_SECRET) missing.push("RENDER_WORKER_SECRET");
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

/**
 * ANGLE backend Chrome should bind WebGL to.
 *
 * On Linux + NVIDIA, "gl" is the backend that reaches the driver, which is what
 * a rented card needs. But it is NOT portable: macOS has no desktop-GL backend,
 * and --use-angle=gl there makes getContext("webgl") return null outright — so
 * every render fails with "no webgl" rather than merely running slowly.
 * Verified locally: --use-angle=gl kills WebGL on an M1, while the platform
 * default gives hardware Metal.
 *
 * So the backend is configurable, and the worker VERIFIES it at launch instead
 * of discovering the mistake one failed job at a time.
 */
const ANGLE_BACKEND =
  process.env.RENDER_ANGLE_BACKEND ?? (process.platform === "linux" ? "gl" : "default");

/**
 * Chrome flags that decide whether WebGL lands on the rented card.
 *
 * Without --enable-gpu / --ignore-gpu-blocklist, Chrome disables the GPU inside
 * a container (no display, unknown driver) and falls back to SwiftShader (CPU):
 * renders still succeed but 10-50x slower, so you pay GPU rates for CPU speed.
 * --headless=new is required — old headless had no GPU path at all.
 */
function chromeArgs(angleBackend) {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    // Containers get a tiny default /dev/shm; Chrome crashes on big canvases.
    "--disable-dev-shm-usage",
    "--enable-gpu",
    // Do NOT let Chrome disable the GPU just because there is no display.
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    // A 2048x2048 canvas plus HDRI textures needs real headroom.
    "--js-flags=--max-old-space-size=8192",
    "--window-size=1920,1080",
    // MediaRecorder must not be throttled while the tab is "hidden".
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
  ];

  // "default" = let Chrome choose (Metal on macOS, GL/Vulkan on Linux).
  if (angleBackend && angleBackend !== "default") {
    args.push(`--use-angle=${angleBackend}`);
  }

  // How ANGLE's "gl" backend actually reaches the driver.
  //
  // In a container there is no X server, so GLX cannot be used — and GLX is
  // what Chrome tries first on Linux. Without EGL it finds no NVIDIA path and
  // silently binds to Mesa's llvmpipe (CPU), which reports as
  // "ANGLE (Mesa, llvmpipe ...)" and renders 10-50x slower for GPU money.
  // Xvfb gives a display but NOT an NVIDIA GLX path, so it does not cover this.
  //
  // Only meaningful on Linux with the gl backend; elsewhere Chrome's own
  // default is already correct and forcing egl would break macOS.
  if (process.platform === "linux" && angleBackend === "gl") {
    args.push(`--use-gl=${process.env.RENDER_GL_IMPL ?? "egl"}`);
  }

  return args;
}

/** The WebGL renderer string, or null when WebGL is unavailable. */
async function probeWebGL(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return null;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Launches Chrome and proves WebGL works BEFORE any job runs.
 *
 * A wrong ANGLE backend produces zero pixels, so failing here — once, loudly —
 * beats burning metered GPU time on renders that cannot succeed.
 */
async function launchBrowser() {
  const attempt = async (backend) => {
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: chromeArgs(backend),
      protocolTimeout: JOB_TIMEOUT_MS + 60_000,
    });
    return { browser, renderer: await probeWebGL(browser), backend };
  };

  const isSoftware = (renderer) =>
    Boolean(renderer) && /swiftshader|software|llvmpipe/i.test(renderer);

  let result = await attempt(ANGLE_BACKEND);

  if (!result.renderer && ANGLE_BACKEND !== "default") {
    log(`no WebGL with --use-angle=${ANGLE_BACKEND} — retrying on the platform default`);
    await result.browser.close().catch(() => undefined);
    result = await attempt("default");
  }

  // WebGL exists but landed on the CPU. That is worse than it looks: renders
  // succeed, so nothing fails loudly, and the bill is GPU-rate for CPU speed.
  // Vulkan reaches the NVIDIA driver through a different path than GL/EGL, so
  // it is worth one try before settling — but only when a card is actually
  // present, since on a genuinely GPU-less host this would just cost time.
  if (isSoftware(result.renderer) && ANGLE_BACKEND !== "vulkan") {
    log(`software renderer (${result.renderer}) — retrying with --use-angle=vulkan`);
    await result.browser.close().catch(() => undefined);
    const vulkanResult = await attempt("vulkan");

    if (vulkanResult.renderer && !isSoftware(vulkanResult.renderer)) {
      log("vulkan backend reached the card — keeping it");
      result = vulkanResult;
    } else {
      // Neither path works: keep the original rather than a second bad one, so
      // the reported renderer matches the configured backend.
      await vulkanResult.browser.close().catch(() => undefined);
      result = await attempt(ANGLE_BACKEND);
    }
  }

  if (!result.renderer) {
    await result.browser.close().catch(() => undefined);
    throw new Error(
      "Chrome has no WebGL in this container: the GPU/GL user space is missing. " +
      "Check that the host passed a card (--gpus all) and that " +
      "NVIDIA_DRIVER_CAPABILITIES includes 'graphics'."
    );
  }

  log(`WebGL renderer: ${result.renderer} (angle=${result.backend})`);
  if (/swiftshader|software|llvmpipe/i.test(result.renderer)) {
    log("WARNING: software rendering — paying GPU rates for CPU speed");
    await logGpuDiagnostics(result.browser);
  }
  return result.browser;
}

/**
 * Explains WHY Chrome fell back to software, instead of only reporting that it
 * did. Runs only on the fallback path, so it costs nothing when things work.
 *
 * The three causes look identical from the renderer string alone — llvmpipe is
 * what you get from all of them:
 *   - the NVIDIA GL/EGL user space was never mounted into the container
 *     (NVIDIA_DRIVER_CAPABILITIES lacking 'graphics', or the host ignoring it)
 *   - the libraries are present but Chrome rejected the GPU for its own reason
 *   - the card is visible to CUDA but not to GL (a compute-only allocation)
 *
 * chrome://gpu tells the second apart from the first, and the presence of
 * libEGL_nvidia / libGLX_nvidia on disk tells the first apart from the third.
 */
async function logGpuDiagnostics(browser) {
  // What Chrome itself decided, and why it says it decided that.
  try {
    const page = await browser.newPage();
    try {
      await page.goto("chrome://gpu", { waitUntil: "domcontentloaded", timeout: 15_000 });
      const summary = await page.evaluate(() => {
        const text = document.body.innerText;
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        // The "Graphics Feature Status" block plus any "Problems Detected".
        const wanted = lines.filter((l) =>
          /^(WebGL|WebGL2|OpenGL|Vulkan|Canvas|Rasterization|Video Decode)[:.]/i.test(l) ||
          /disabled|blocklisted|software only|unavailable/i.test(l)
        );
        return wanted.slice(0, 25).join(" | ");
      });
      log(`chrome://gpu says: ${summary || "(no status lines found)"}`);
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch (error) {
    log(`chrome://gpu probe failed: ${error.message}`);
  }

  // Whether the NVIDIA GL user space was mounted at all. If these are absent,
  // the container never had a GL path to the card and no Chrome flag can fix
  // it — it is a host/capabilities problem, not a browser one.
  try {
    const { execSync } = await import("node:child_process");
    const found = execSync(
      "ls /usr/lib/x86_64-linux-gnu/ 2>/dev/null | grep -E '^lib(EGL|GLX|GL)_nvidia' || true",
      { encoding: "utf8", timeout: 10_000 }
    ).trim();
    log(
      found
        ? `NVIDIA GL libraries present: ${found.split("\n").join(", ")}`
        : "NVIDIA GL libraries NOT mounted (no libEGL_nvidia / libGLX_nvidia) — " +
          "the host did not grant 'graphics' capability, so GL cannot reach the card"
    );

    const nvidiaSmi = execSync(
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>&1 || true",
      { encoding: "utf8", timeout: 10_000 }
    ).trim();
    log(`nvidia-smi: ${nvidiaSmi || "(no output)"}`);
  } catch (error) {
    log(`library probe failed: ${error.message}`);
  }
}

/**
 * Asks whether anything is still queued, so a warm pod can take one more job.
 *
 * This MUST NOT claim: the render page does the claiming. A claim here would
 * mark the job 'running' with no renderer attached, and it would only come
 * back after its lease expired.
 */
async function queueHasWork() {
  const res = await fetch(`${APP_BASE_URL}/api/render-worker/queue-depth`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${WORKER_SECRET}`,
      "x-worker-id": WORKER_ID,
    },
  });
  if (!res.ok) return false;
  const data = await res.json();
  return (data.queued ?? 0) > 0;
}

/** Renders one job in a fresh page and returns its result. */
async function runJob(browser, jobId) {
  const jobStartedAt = Date.now();
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

  // Surface the page's own logs into the pod log — without this a failing
  // render is invisible.
  page.on("console", (msg) => log("page:", msg.text()));
  page.on("pageerror", (err) => log("page error:", err.message));
  page.on("requestfailed", (req) =>
    log("request failed:", req.url(), req.failure()?.errorText)
  );

  // provider/worker land on the job row so a month's GPU bill can be traced
  // back to the pods that produced it.
  const url =
    `${APP_BASE_URL}/render-worker` +
    `?jobId=${encodeURIComponent(jobId ?? "")}` +
    `&token=${encodeURIComponent(WORKER_SECRET)}` +
    `&provider=${encodeURIComponent(PROVIDER)}` +
    `&worker=${encodeURIComponent(WORKER_ID)}`;

  try {
    log(`opening job ${jobId ?? "(queue)"}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });

    const result = await page.waitForFunction(
      () => window.__renderWorkerResult ?? null,
      { timeout: JOB_TIMEOUT_MS, polling: 1000 }
    );
    const value = await result.jsonValue();

    const durationMs = Date.now() - jobStartedAt;

    if (value.status !== "succeeded") {
      const trail = await page.evaluate(() => window.__renderWorkerLog ?? []);
      log("job failed:", value.error);
      for (const line of trail.slice(-20)) log(" ", line);
    } else {
      log(`job done: ${value.outputCount} file(s) in ${Math.round(durationMs / 1000)}s`);
    }
    // durationMs feeds the run-budget check: the next job is assumed to cost
    // about as much as the slowest one so far.
    return { ...value, durationMs };
  } catch (error) {
    log("job crashed:", error.message);
    const trail = await page
      .evaluate(() => window.__renderWorkerLog ?? [])
      .catch(() => []);
    for (const line of trail.slice(-20)) log(" ", line);
    return {
      status: "failed",
      outputCount: 0,
      error: error.message,
      durationMs: Date.now() - jobStartedAt,
    };
  } finally {
    // A page holding a WebGL context leaks GPU memory across jobs.
    await page.close().catch(() => undefined);
  }
}

export async function handler(input = {}) {
  assertEnv();

  const browser = await launchBrowser();

  const results = [];
  const startedAt = Date.now();
  try {
    // The job this pod was woken for.
    const first = await runJob(browser, input.jobId);
    results.push(first);

    // Drain only while the queue is deeper than the pool of pods — the cold
    // start is the expensive part, so a warm card should not walk away from
    // work that has no pod. Each extra job is whatever is oldest in the queue,
    // NOT necessarily the same product.
    for (let i = 1; i < MAX_JOBS_PER_RUN; i++) {
      const elapsed = Date.now() - startedAt;
      // Budget check: assume the next job costs as much as the slowest so far.
      // Being killed mid-render strands that job until its lease expires, so
      // exiting early is strictly better than starting a job we cannot finish.
      if (RUN_BUDGET_MS > 0) {
        const slowest = Math.max(...results.map((r) => r.durationMs ?? 0), 0);
        if (elapsed + slowest > RUN_BUDGET_MS) {
          log(
            `stopping after ${results.length} job(s): ${Math.round(elapsed / 1000)}s used, ` +
            `another ~${Math.round(slowest / 1000)}s would exceed the ` +
            `${Math.round(RUN_BUDGET_MS / 1000)}s run budget`
          );
          break;
        }
      }

      let more = false;
      try {
        more = await queueHasWork();
      } catch (error) {
        log("queue check failed:", error.message);
      }
      if (!more) break;
      log(`queue still busy — taking job ${i + 1}/${MAX_JOBS_PER_RUN}`);
      results.push(await runJob(browser, undefined));
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return {
    worker: WORKER_ID,
    jobs: results.length,
    succeeded: results.filter((r) => r.status === "succeeded").length,
    failed: results.filter((r) => r.status !== "succeeded").length,
    results,
  };
}

/** Direct run: `node worker.mjs <jobId>` — used for local testing. */
if (process.argv[1]?.endsWith("worker.mjs")) {
  handler({ jobId: process.argv[2] })
    .then((summary) => {
      log("summary:", JSON.stringify(summary));
      process.exit(summary.failed > 0 ? 1 : 0);
    })
    .catch((error) => {
      log("fatal:", error);
      process.exit(1);
    });
}
