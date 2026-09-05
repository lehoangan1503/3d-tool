import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { getRecordingDimensions } from "@/types/video-studio";
import type { DeterministicFrameSink, VideoStudioConfig } from "@/types/video-studio";

/**
 * Browser-side frame sink: WebCodecs in, finished .mp4 out.
 *
 * The GPU worker writes lossless PNGs to the pod's disk and lets ffmpeg encode
 * them afterwards, because that container has both a disk and an ffmpeg binary.
 * A browser has neither, and the naive workaround — ship 1200 PNGs somewhere
 * that does — moves several GB across the network to produce a ~40 MB file.
 *
 * So this sink encodes each frame the moment it is drawn. What makes that safe
 * is that WebCodecs, unlike MediaRecorder, never samples: it encodes exactly the
 * frames it is handed, and `encodeQueueSize` reports its backlog. Awaiting that
 * backlog is the same backpressure the worker gets from awaiting a disk write —
 * which is the entire reason no frame can be dropped.
 */

/** Never let more than this many frames sit unencoded. */
const MAX_ENCODE_QUEUE = 8;

/**
 * Frames per keyframe. Every 2 s of footage at any fps: short enough to keep
 * seeking responsive, long enough not to spend the bitrate on I-frames.
 */
const KEYFRAME_EVERY_SECONDS = 2;

/**
 * H.264 level 5.2 — the first level that covers 2560x1440 at 60fps and above.
 * `avc1.640034` is High profile, level 5.2; hardware encoders that decline it
 * fall through to the codec probe below.
 */
const CODEC_CANDIDATES = ["avc1.640034", "avc1.4d0034", "avc1.640033"] as const;

export interface WebCodecsSinkOptions {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate: number;
  /**
   * When the source canvas is larger than width/height, each frame is scaled
   * down on its way into the encoder.
   *
   * This is supersampling, and it exists because MSAA is capped by the driver:
   * Chrome on Apple silicon reports MAX_SAMPLES = 4 through ANGLE/Metal, while
   * the pod's NVIDIA stack offers more. Rendering large and shrinking averages
   * several rendered samples into every output pixel, which recovers the fine
   * texture detail (leather grain, wood figure) that 4x MSAA smears — without
   * depending on what the driver is willing to give.
   */
  readonly supersample?: boolean;
}

/** True when this browser can encode video with WebCodecs at all. */
export function isWebCodecsSupported(): boolean {
  return typeof window !== "undefined" && typeof window.VideoEncoder === "function";
}

/**
 * Finds an encoder configuration this browser will actually run.
 *
 * `isConfigSupported` alone is not trustworthy: it answers for the codec in the
 * abstract, and Chrome has been observed returning `supported: true` for a
 * config whose `configure()` then throws "Encoder creation error" — so probing
 * that way and believing it moves the failure to the first frame, after the
 * scene has already been set up.
 *
 * The only honest test is to build the encoder and configure it, which is what
 * this does, discarding each trial encoder until one survives. Hardware is
 * preferred but never required; every candidate is tried at software before
 * giving up, since a working software encoder still beats no recording.
 */
async function resolveEncoderConfig(
  opts: WebCodecsSinkOptions
): Promise<VideoEncoderConfig> {
  const attempts: string[] = [];

  for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
    for (const codec of CODEC_CANDIDATES) {
      const config: VideoEncoderConfig = {
        codec,
        width: opts.width,
        height: opts.height,
        bitrate: opts.bitrate,
        framerate: opts.fps,
        // Constant bitrate: the studio's smooth gradients and polished metal are
        // exactly what a variable-rate encoder starves to save bits, and that
        // starvation is the banding the old VP9 path produced.
        bitrateMode: "constant",
        // Annex-B carries parameter sets inline; the muxer wants them in the
        // sample description instead, which is what "avc" format means here.
        avc: { format: "avc" },
        hardwareAcceleration,
      };

      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (!support.supported) {
          attempts.push(`${codec}/${hardwareAcceleration}: unsupported`);
          continue;
        }
      } catch (err) {
        // isConfigSupported rejects a malformed config rather than returning
        // false, so one bad candidate must not abort the search.
        attempts.push(`${codec}/${hardwareAcceleration}: probe threw ${String(err)}`);
        continue;
      }

      // The probe said yes; find out whether it meant it.
      const trial = new VideoEncoder({ output: () => {}, error: () => {} });
      try {
        trial.configure(config);
        return config;
      } catch (err) {
        attempts.push(`${codec}/${hardwareAcceleration}: configure threw ${String(err)}`);
      } finally {
        // close() throws if configure() already left it unconfigured.
        try { trial.close(); } catch { /* already dead */ }
      }
    }
  }

  throw new Error(
    `No usable H.264 encoder for ${opts.width}x${opts.height}@${opts.fps}fps. ` +
    `Tried — ${attempts.join("; ")}`
  );
}

/**
 * Builds a sink that encodes straight from the canvas and finalises an MP4.
 *
 * Call it before recording starts: it probes codec support up front, so an
 * unsupported browser fails before a single frame has been rendered rather than
 * a thousand frames in.
 */
export async function createWebCodecsFrameSink(
  opts: WebCodecsSinkOptions
): Promise<DeterministicFrameSink> {
  if (!isWebCodecsSupported()) {
    throw new Error("This browser has no WebCodecs VideoEncoder");
  }

  const config = await resolveEncoderConfig(opts);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: "avc",
      width: opts.width,
      height: opts.height,
      frameRate: opts.fps,
    },
    // The whole file is held in memory anyway (it ends up as a Blob), and
    // in-memory Fast Start puts the metadata first — so the result plays
    // immediately instead of seeking to the end for its index.
    fastStart: "in-memory",
  });

  // The first encoder error must survive to be thrown from writeFrame, because
  // WebCodecs reports failures on this callback rather than by rejecting.
  let encodeError: Error | null = null;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err));
    },
  });

  // Exactly the config that a trial encoder already accepted above.
  encoder.configure(config);

  const keyFrameInterval = Math.max(1, Math.round(opts.fps * KEYFRAME_EVERY_SECONDS));
  /** Microseconds per frame — WebCodecs timestamps are integer microseconds. */
  const frameDurationUs = Math.round(1_000_000 / opts.fps);

  const throwIfFailed = () => {
    if (encodeError) throw encodeError;
  };

  /**
   * Reusable target for the supersampling downscale.
   *
   * Allocated once per take rather than per frame: a 1440x1440 canvas is several
   * megabytes, and churning one every frame would have the garbage collector
   * pausing the render loop it is supposed to be feeding.
   */
  let scratch: HTMLCanvasElement | null = null;
  let scratchCtx: CanvasRenderingContext2D | null = null;

  const downscale = (source: HTMLCanvasElement): HTMLCanvasElement => {
    if (!scratch || !scratchCtx) {
      scratch = document.createElement("canvas");
      scratch.width = opts.width;
      scratch.height = opts.height;
      const ctx = scratch.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Could not create a 2D context for supersampling");
      // Without this the browser is free to pick nearest-neighbour, which would
      // throw away the extra samples that are the entire point of rendering big.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      scratchCtx = ctx;
    }
    scratchCtx.drawImage(source, 0, 0, opts.width, opts.height);
    return scratch;
  };

  /** Blocks until the encoder's backlog is small enough to accept more work. */
  const drainQueue = async (limit: number): Promise<void> => {
    while (encoder.encodeQueueSize > limit) {
      throwIfFailed();
      await new Promise<void>((resolve) => {
        encoder.addEventListener("dequeue", () => resolve(), { once: true });
      });
    }
  };

  const encodeFrame = async (index: number, frame: VideoFrame): Promise<void> => {
    try {
      throwIfFailed();
      encoder.encode(frame, { keyFrame: index % keyFrameInterval === 0 });
    } finally {
      // VideoFrame holds a GPU buffer that is NOT garbage collected. Leaking one
      // per frame exhausts the pool within a few hundred frames and every later
      // encode fails.
      frame.close();
    }
    // THE backpressure point, mirroring the worker's `await writeFrame`. Frame
    // N+1 is not rendered until the encoder has room, so nothing is ever
    // sampled, skipped, or silently traded away for speed.
    await drainQueue(MAX_ENCODE_QUEUE);
  };

  return {
    /**
     * Encodes directly from the canvas — no PNG in between.
     *
     * The worker round-trips through PNG only because its frames must cross into
     * Node as JSON, where binary cannot go. Here the encoder is in the same
     * process as the canvas, and PNG compression at 2K costs more main-thread
     * time than drawing the frame did.
     */
    async writeCanvasFrame(index: number, canvas: HTMLCanvasElement): Promise<void> {
      const timestamp = index * frameDurationUs;
      // A canvas bigger than the output is supersampled down. drawImage does the
      // box filter on the GPU, so every output pixel averages the several
      // rendered samples that landed inside it.
      const source =
        canvas.width === opts.width && canvas.height === opts.height
          ? canvas
          : downscale(canvas);
      await encodeFrame(
        index,
        new VideoFrame(source, { timestamp, duration: frameDurationUs })
      );
    },

    /**
     * PNG fallback, kept so this sink still satisfies the shared contract. A
     * caller that already holds an encoded blob decodes it back to a bitmap;
     * writeCanvasFrame is strictly cheaper and is what the recorder uses.
     */
    async writeFrame(index: number, frame: Blob): Promise<void> {
      const bitmap = await createImageBitmap(frame);
      const timestamp = index * frameDurationUs;
      try {
        await encodeFrame(
          index,
          new VideoFrame(bitmap, { timestamp, duration: frameDurationUs })
        );
      } finally {
        bitmap.close();
      }
    },

    /**
     * Drops the encoder without producing a file. Safe to call at any point,
     * including after finish(), so a caller's cleanup path needs no bookkeeping.
     */
    abort(): void {
      // close() throws on an already-closed encoder, and this runs while an
      // error may already be propagating — swallowing is the point.
      try { encoder.close(); } catch { /* already closed */ }
    },

    async finish(): Promise<Blob> {
      // flush() resolves only once every queued frame has been encoded and
      // handed to the muxer, so no tail frames can be lost at the cut.
      await encoder.flush();
      throwIfFailed();
      encoder.close();
      muxer.finalize();
      const { buffer } = muxer.target;
      return new Blob([buffer], { type: "video/mp4" });
    },
  };
}

/**
 * Bitrate multiplier applied on top of the quality preset.
 *
 * The presets were written for MediaRecorder's software VP9, which never
 * delivered what it was asked for (20 Mbps requested, ~8 measured). A hardware
 * H.264 encoder does deliver it, so the headroom that used to be swallowed is
 * now real output — hence a modest bump rather than a large one.
 *
 * Measured on 60 frames of a real studio take at 1440x1440, against the
 * lossless source: 10 Mbps scored 30.45 dB PSNR, 22 Mbps scored 30.54 dB. The
 * whole 12 Mbps bought 0.09 dB, which is far below anything an eye resolves —
 * studio footage is a slow camera over smooth surfaces, which is exactly the
 * content that saturates a codec early. An earlier 2.5x here simply doubled
 * every file for no visible gain.
 */
const BROWSER_BITRATE_MULTIPLIER = 1.4;

/**
 * Builds the sink for a browser-side take of the given studio config.
 *
 * Wraps createWebCodecsFrameSink with the resolution, fps and bitrate that
 * getRecordingDimensions derives from the config, so no caller has to restate
 * the mapping from quality + ratio to encoder settings.
 */
export async function createStudioFrameSink(
  config: VideoStudioConfig
): Promise<DeterministicFrameSink> {
  const dims = getRecordingDimensions(config.quality ?? "2k", config.videoRatio ?? "16:9");
  return createWebCodecsFrameSink({
    width: dims.width,
    height: dims.height,
    fps: dims.fps,
    bitrate: Math.round(dims.bitrate * BROWSER_BITRATE_MULTIPLIER),
  });
}

/**
 * How much larger than the output a browser take renders.
 *
 * 2 means every frame is drawn at 4x the pixels and averaged down, which is what
 * closes the measured detail gap against the pod's renders — the pod's driver
 * offers more MSAA samples than ANGLE/Metal will, and this buys the difference
 * back in a way no driver can cap. The cost is fill rate, paid in render time.
 */
export const BROWSER_SUPERSAMPLE = 2;
