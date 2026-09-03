import { Suspense } from "react";
import RenderWorkerClient from "@/components/render-worker/render-worker-client";

/**
 * The page a GPU worker's headless Chrome opens.
 *
 * Everything in src/lib/three needs a real browser — WebGL, document.createElement
 * ("canvas"), new Image(), and for video MediaRecorder + canvas.captureStream.
 * None of that exists in Node, so the render engine cannot be imported into an
 * API route. Running it inside a headless Chrome that sits on a rented GPU is
 * what lets the existing 250KB ExtractorSceneManager be reused verbatim —
 * server renders come out pixel-identical to what the operator previews.
 *
 * The worker container navigates to:
 *   /render-worker?jobId=<uuid>&token=<RENDER_WORKER_SECRET>
 * then waits for window.__renderWorkerResult to be set.
 *
 * The token never reaches this server component: the client passes it straight
 * back to the worker API on the same origin, and the page is noindex.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Render worker",
  robots: { index: false, follow: false },
};

export default function RenderWorkerPage() {
  return (
    <Suspense fallback={<div id="render-worker-status">loading</div>}>
      <RenderWorkerClient />
    </Suspense>
  );
}
