"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SceneManager } from "@/lib/three/scene-manager";
import { ExtractorSceneManager } from "@/lib/three/extractor-scene-manager";
import { renderReferenceToBlob } from "@/components/editor/image-extractor";
import { MODEL_PATHS } from "@/types/product";
import { ensureFullConfig } from "@/types/video-studio";
import type { ExtractorReference } from "@/types/extractor";
import type {
  ClaimedRenderJob,
  RenderImagePayload,
  RenderJobProduct,
  RenderVideoPayload,
} from "@/types/render-job";
import { isImagePayload, isVideoPayload } from "@/types/render-job";

/**
 * Runs one render job inside the GPU container's headless Chrome.
 *
 * The container navigates here with ?jobId&token, this component does the work,
 * and Puppeteer waits for window.__renderWorkerResult. Progress and outputs go
 * to the worker API on this same origin, so the browser needs no Supabase
 * session and the container never holds the service key.
 */

interface WorkerResult {
  status: "succeeded" | "failed";
  outputCount: number;
  error?: string;
}

declare global {
  interface Window {
    /** Puppeteer polls this; set exactly once, when the job is fully done. */
    __renderWorkerResult?: WorkerResult;
    /** Human-readable trail, dumped to the pod log when a render fails. */
    __renderWorkerLog?: string[];
  }
}

function log(message: string): void {
  const line = `[render-worker] ${message}`;
  console.log(line);
  if (typeof window !== "undefined") {
    window.__renderWorkerLog = [...(window.__renderWorkerLog ?? []), line];
  }
}

/** A canceled or vanished job makes the worker stop early and save GPU time. */
class JobCanceledError extends Error {
  constructor() {
    super("Job was canceled");
    this.name = "JobCanceledError";
  }
}

/**
 * Loads the product's model into an ESM. Mirrors loadProductIntoEsm but takes
 * the settings from the job payload instead of fetching an authenticated
 * endpoint — the worker has no session.
 */
async function loadProductModel(
  product: RenderJobProduct
): Promise<NonNullable<ReturnType<SceneManager["getModelForClone"]>>> {
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;";
  document.body.appendChild(container);

  const sm = new SceneManager(container);
  try {
    await sm.loadModel(MODEL_PATHS[product.type]);

    await sm.applySurface({
      surfaceUrl: product.surfaceUrl,
      productType: product.type,
      leatherColor: product.color,
      leatherTexture: product.textureType,
      textureScale: product.config?.textureScale ?? 1,
      logoId: product.config?.logoId ?? "uni",
    });

    if (product.config) {
      sm.updateBodyRoughness(product.config.bodyRoughness);
      sm.updateJointConfig({
        roughness: product.config.jointRoughness,
        clearcoat: product.config.jointClearcoat,
        metalness: product.config.jointMetalness,
      });
    }

    const model = sm.getModelForClone();
    if (!model) throw new Error(`No model loaded for product "${product.name}"`);
    return model;
  } finally {
    // The model is cloned into the ESM, so the loader scene can go away and
    // free its WebGL context — the container may run several jobs in a row.
    sm.dispose();
    container.remove();
  }
}

export default function RenderWorkerClient() {
  const searchParams = useSearchParams();
  const jobId = searchParams.get("jobId");
  const token = searchParams.get("token");
  // Recorded on the job row so GPU spend can be traced back to a pod.
  const provider = searchParams.get("provider");
  const workerId = searchParams.get("worker");

  const [status, setStatus] = useState("starting");
  // React StrictMode double-mounts in dev; a job must never render twice.
  const startedRef = useRef(false);
  const canceledRef = useRef(false);
  const videoContainerRef = useRef<HTMLDivElement>(null);

  const authHeaders = useCallback(
    (extra: Record<string, string> = {}) => ({
      Authorization: `Bearer ${token ?? ""}`,
      ...extra,
    }),
    [token]
  );

  /** Heartbeat + cancel check. Throws JobCanceledError to unwind the render. */
  const reportProgress = useCallback(
    async (
      activeJobId: string,
      done: number,
      total: number,
      label?: string
    ): Promise<void> => {
      const res = await fetch(`/api/render-worker/${activeJobId}/progress`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ done, total, label }),
      });

      if (!res.ok) {
        log(`progress beat failed: ${res.status}`);
        return;
      }
      const data = (await res.json()) as { canceled?: boolean };
      if (data.canceled) {
        canceledRef.current = true;
        throw new JobCanceledError();
      }
    },
    [authHeaders]
  );

  const uploadOutput = useCallback(
    async (
      activeJobId: string,
      blob: Blob,
      name: string,
      width: number,
      height: number
    ): Promise<void> => {
      const form = new FormData();
      const ext = blob.type.includes("webm")
        ? "webm"
        : blob.type.includes("mp4")
          ? "mp4"
          : blob.type.includes("jpeg")
            ? "jpg"
            : "png";
      form.append("file", blob, `${name}.${ext}`);
      form.append("name", name);
      form.append("width", String(width));
      form.append("height", String(height));

      const res = await fetch(`/api/render-worker/${activeJobId}/upload`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload of "${name}" failed: ${res.status} ${text.slice(0, 200)}`);
      }
    },
    [authHeaders]
  );

  /** Renders every reference in the group, uploading each as it finishes. */
  const runImageJob = useCallback(
    async (activeJobId: string, payload: RenderImagePayload): Promise<number> => {
      const { product, references, format, quality } = payload;
      log(`image job: ${references.length} refs for "${product.name}"`);

      const model = await loadProductModel(product);
      let uploaded = 0;

      for (let i = 0; i < references.length; i++) {
        const ref: ExtractorReference = references[i];
        await reportProgress(activeJobId, i, references.length, `Đang render ${ref.name}`);

        try {
          // The very same function the browser deploy dialog calls, so a
          // server render is pixel-identical to the operator's preview.
          const pngBlob = await renderReferenceToBlob(model, ref, undefined, product.surfaceUrl);

          const blob = format === "jpeg" ? await toJpeg(pngBlob, quality) : pngBlob;

          await uploadOutput(
            activeJobId,
            blob,
            ref.name,
            ref.canvasWidth ?? 2048,
            ref.canvasHeight ?? 2048
          );
          uploaded++;
        } catch (error) {
          if (error instanceof JobCanceledError) throw error;
          // One bad layout must not lose the other five mockups.
          log(`ref "${ref.name}" failed: ${error instanceof Error ? error.message : error}`);
        }
      }

      await reportProgress(activeJobId, references.length, references.length, "Hoàn tất");
      return uploaded;
    },
    [reportProgress, uploadOutput]
  );

  /** Records the studio template to a video file. */
  const runVideoJob = useCallback(
    async (activeJobId: string, payload: RenderVideoPayload): Promise<number> => {
      const { product, config, width, height, templateName } = payload;
      log(`video job: "${templateName}" for "${product.name}" @ ${width}x${height}`);

      const model = await loadProductModel(product);
      const esm = new ExtractorSceneManager(width, height);

      // Chrome throttles requestAnimationFrame for off-screen canvases, which
      // makes captureStream drop frames. The canvas must be genuinely visible
      // even in headless — hence a real on-screen container, not display:none.
      const canvas = esm.getCanvas();
      canvas.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;";
      if (videoContainerRef.current) {
        videoContainerRef.current.innerHTML = "";
        videoContainerRef.current.appendChild(canvas);
      }

      try {
        esm.setModel(model);

        let lastBeat = 0;
        const blob = await esm.startStudioRecording(ensureFullConfig(config), (pct: number) => {
          // The recorder callback cannot await, so cancellation is checked on a
          // throttled beat and the error surfaces on the next one.
          const now = performance.now();
          if (canceledRef.current) {
            esm.stopRecording();
            return;
          }
          if (pct >= 100 || now - lastBeat >= 2000) {
            lastBeat = now;
            void reportProgress(activeJobId, Math.round(pct), 100, `Render video ${Math.round(pct)}%`)
              .catch(() => { canceledRef.current = true; esm.stopRecording(); });
          }
        });

        if (canceledRef.current) throw new JobCanceledError();

        await uploadOutput(activeJobId, blob, templateName || "video", width, height);
        await reportProgress(activeJobId, 100, 100, "Hoàn tất");
        return 1;
      } finally {
        esm.dispose();
      }
    },
    [reportProgress, uploadOutput]
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (!jobId || !token) {
      const message = "Missing jobId or token";
      window.__renderWorkerResult = { status: "failed", outputCount: 0, error: message };
      // Deferred so the effect body does not setState synchronously.
      queueMicrotask(() => setStatus(`error: ${message}`));
      return;
    }

    void (async () => {
      let outputCount = 0;
      // The job actually claimed. Usually the URL's jobId, but a targeted claim
      // that missed falls back to another queued job, and every write after
      // this point must address the job we really hold.
      let activeJobId = jobId;
      try {
        setStatus("claiming");

        // The pod claims THIS job specifically (it was dispatched for it), so
        // the worker API hands back the frozen payload.
        const res = await fetch(`/api/render-worker/claim`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ jobId, provider, workerJobId: workerId }),
        });

        if (res.status === 204) {
          setStatus("idle: queue empty");
          window.__renderWorkerResult = { status: "succeeded", outputCount: 0 };
          return;
        }
        if (!res.ok) {
          throw new Error(`Claim failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
        }

        const job = (await res.json()) as ClaimedRenderJob;
        activeJobId = job.id;
        setStatus(`rendering ${job.kind}`);

        if (isImagePayload(job.payload)) {
          outputCount = await runImageJob(activeJobId, job.payload);
        } else if (isVideoPayload(job.payload)) {
          outputCount = await runVideoJob(activeJobId, job.payload);
        } else {
          throw new Error(`Unknown payload kind on job ${job.id}`);
        }

        await fetch(`/api/render-worker/${activeJobId}/complete`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ status: "succeeded" }),
        });

        setStatus(`done: ${outputCount} file(s)`);
        window.__renderWorkerResult = { status: "succeeded", outputCount };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (error instanceof JobCanceledError) {
          // The status is already 'canceled'; completing would fight the user.
          setStatus("canceled");
          window.__renderWorkerResult = { status: "succeeded", outputCount, error: "canceled" };
          return;
        }

        log(`job failed: ${message}`);
        await fetch(`/api/render-worker/${activeJobId}/complete`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ status: "failed", errorMessage: message }),
        }).catch(() => undefined);

        setStatus(`error: ${message}`);
        window.__renderWorkerResult = { status: "failed", outputCount, error: message };
      }
    })();
  }, [jobId, token, provider, workerId, authHeaders, runImageJob, runVideoJob]);

  return (
    <div style={{ margin: 0, background: "#111", color: "#eee", fontFamily: "monospace" }}>
      {/* Puppeteer reads this for logs on failure. */}
      <div id="render-worker-status">{status}</div>
      {/* Must stay visible and correctly sized: an off-screen canvas gets its
          rAF throttled by Chrome and the recording drops frames. */}
      <div
        ref={videoContainerRef}
        style={{ width: "1280px", height: "720px", overflow: "hidden" }}
      />
    </div>
  );
}

/** Re-encodes a rendered PNG as JPEG, to keep Shopify uploads small. */
async function toJpeg(pngBlob: Blob, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(pngBlob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  // JPEG has no alpha: flatten onto white, or transparent mockups turn black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("JPEG encode failed"))),
      "image/jpeg",
      quality
    );
  });
}
