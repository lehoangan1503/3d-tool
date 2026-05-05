# Recording Quality & Simulator Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix simulator stretched canvas, stop sceneViewAnimate loop during recording to free CPU, and replace timeslice warmup with wall-clock pre-roll so estimated duration = exact video duration.

**Architecture:**
- Task 1 is isolated to `shadow-simulate-dialog.tsx` — add ResizeObserver and fix canvas setup like video-studio does.
- Task 2 is isolated to `video-studio.tsx` — expose a stop/start handle for the `sceneViewAnimate` rAF loop so `handleRecord` can pause it during recording and resume after.
- Task 3 is the most complex — replaces the timeslice-based warmup in `extractor-scene-manager.ts` with a wall-clock pre-roll phase tracked by `performance.now()`, plus a new `_findClusterOffsetAtTime` helper that trims the pre-roll from the WebM binary in post-processing.

**Tech Stack:** TypeScript, Three.js, MediaRecorder API, WebM/EBML binary parsing.

---

### Task 1: Simulator canvas aspect ratio fix

**Files:**
- Modify: `src/components/editor/shadow-simulate-dialog.tsx` — setup block at lines 486–496

**Problem:** Canvas CSS `height="100%"` + `objectFit="fill"` (which does nothing on canvas) + no ResizeObserver means the canvas may be sized with a 1:1 fallback ratio (line 495: `h = rect.height || w`) while the container is non-square. The 3D buffer is square but CSS stretches it to fill the non-square container → horizontal stretch + black gaps.

**Fix:** Match the exact approach used in video-studio.tsx:
1. Replace `objectFit="fill"` with `display="block"` (canvas is inline by default; block prevents bottom gap)
2. Add a ResizeObserver on `previewContainerRef` that calls `esm.resize(newW, newH)` when the container dimensions change — same as `resizePreviewCanvas` in video-studio

**Step 1: Change canvas setup in simulator**

In `src/components/editor/shadow-simulate-dialog.tsx`, around line 488–496, replace:
```typescript
canvas.style.width = "100%";
canvas.style.height = "100%";
canvas.style.objectFit = "fill";
previewContainerRef.current.innerHTML = "";
previewContainerRef.current.appendChild(canvas);
const rect = previewContainerRef.current.getBoundingClientRect();
const w = Math.max(rect.width || 800, 1);
const h = Math.max(rect.height || w, 1);
esm.resize(w, h);
```
With:
```typescript
canvas.style.width = "100%";
canvas.style.height = "100%";
canvas.style.display = "block";
previewContainerRef.current.innerHTML = "";
previewContainerRef.current.appendChild(canvas);
const rect = previewContainerRef.current.getBoundingClientRect();
const w = Math.max(rect.width || 800, 1);
const h = Math.max(rect.height || Math.round(w * 9 / 16), 1);
esm.resize(w, h);
```

**Step 2: Add ResizeObserver in simulator setup()**

After the `esm.resize(w, h)` call and before `esm.initSceneView()`, add:
```typescript
// Track container size so canvas buffer always matches displayed size
const ro = new ResizeObserver(() => {
  if (!previewContainerRef.current || !esmRef.current) return;
  const r = previewContainerRef.current.getBoundingClientRect();
  const rw = Math.max(r.width, 1);
  const rh = Math.max(r.height, 1);
  esmRef.current.resize(rw, rh);
});
ro.observe(previewContainerRef.current);
```

In the cleanup return function for the same useEffect, add `ro.disconnect()`.

**Step 3: Build and verify**

```bash
npm run build
```
Expected: 0 TypeScript errors.

**Step 4: Commit**

```bash
git add src/components/editor/shadow-simulate-dialog.tsx
git commit -m "fix: simulator canvas aspect ratio and black gap via ResizeObserver

- Replace objectFit=fill (no-op on canvas) with display=block
- Fall back to 16:9 ratio instead of 1:1 when container height=0
- Add ResizeObserver so buffer always matches container size

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Pause sceneViewAnimate loop during recording

**Files:**
- Modify: `src/components/editor/video-studio/video-studio.tsx`

**Problem:** The `sceneViewAnimate` rAF loop defined inside the `setup()` useEffect keeps running during recording (even though it skips `controls.update()`). Each tick still calls `requestAnimationFrame`, scheduling 60 wakeups per second on the main thread. This competes with the recording rAF loop for scheduling priority and wastes event-loop cycles. Stopping it during recording and restarting after frees the main thread for the recording loop.

**Current code structure (lines ~344–547):**
```typescript
useEffect(() => {
  let sceneViewAnimId: number | null = null;
  const setup = async () => {
    // ...
    const sceneViewAnimate = () => {
      if (!isRecordingRef.current) {
        sceneViewControlsRef.current?.update();
      }
      sceneViewAnimId = requestAnimationFrame(sceneViewAnimate);
    };
    sceneViewAnimate();
  };
  setup();
  return () => {
    if (sceneViewAnimId) cancelAnimationFrame(sceneViewAnimId);
    // ...
  };
}, [open, sceneManager]);
```

**Fix:** Expose the loop via a ref so `handleRecord` can stop/restart it.

**Step 1: Add a sceneViewLoopRef**

Near the other `useRef` declarations (~line 216), add:
```typescript
const sceneViewLoopRef = useRef<{ stop: () => void; start: () => void } | null>(null);
```

**Step 2: Wire up the ref in setup()**

After `sceneViewAnimate` is defined and called, add:
```typescript
sceneViewLoopRef.current = {
  stop: () => {
    if (sceneViewAnimId !== null) {
      cancelAnimationFrame(sceneViewAnimId);
      sceneViewAnimId = null;
    }
  },
  start: () => {
    if (sceneViewAnimId === null) sceneViewAnimate();
  },
};
```

In the cleanup return, also clear the ref:
```typescript
sceneViewLoopRef.current = null;
```

**Step 3: Stop before recording, restart after**

In `handleRecord` (~line 686), immediately after:
```typescript
setIsRecording(true);
isRecordingRef.current = true;
```
Add:
```typescript
sceneViewLoopRef.current?.stop();
```

In the `finally` block of `handleRecord` (~line 733), after:
```typescript
setIsRecording(false);
isRecordingRef.current = false;
```
Add:
```typescript
sceneViewLoopRef.current?.start();
```

**Step 4: Build and verify**

```bash
npm run build
```
Expected: 0 TypeScript errors.

**Step 5: Commit**

```bash
git add src/components/editor/video-studio/video-studio.tsx
git commit -m "perf: stop sceneViewAnimate rAF loop during recording

Prevents 60fps scheduler wakeups from competing with the recording
loop. Exposes stop/start handle via sceneViewLoopRef so handleRecord
can pause and resume the loop cleanly.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Wall-clock pre-roll replaces timeslice warmup

**Files:**
- Modify: `src/lib/three/extractor-scene-manager.ts` — `_startStudioRecordingLoop` method and warmup helpers

**Problem:** With `mediaRecorder.start(ENCODER_WARMUP_MS)` the first timeslice fires at ~2000ms but its exact boundary is browser-dependent. If it fires at 2050ms, `firstTc = 2050` and after re-zeroing the animation content is ~`durationMs` but the last cluster alignment may not reach `durationMs` exactly because the last timeslice fires after the loop stops. Result: final video is slightly shorter than estimated.

**New approach:**
1. `mediaRecorder.start()` — no timeslice, all data arrives as ONE chunk on `stop()`
2. Phase 1 (pre-roll): render static frame 0 for exactly `PRE_ROLL_MS` wall-clock time (tracked by `performance.now()`)
3. Phase 2: render animation for exactly `durationMs` wall-clock time
4. `onstop`: ONE blob with all data. Extract EBML header (everything before first cluster). Find byte offset of first cluster with timecode ≥ `PRE_ROLL_MS` using new `_findClusterOffsetAtTime`. Trim pre-roll clusters. Re-zero remaining timestamps by subtracting the first animation cluster timecode. Patch Duration = `durationMs`.

**Why this is cleaner:**
- No dependency on timeslice boundary; wall-clock timer is exact
- Animation always runs for exactly `durationMs` ms (loop condition: `elapsedMs >= durationMs`)
- Single-chunk output simplifies `onstop` (no `warmupBlob` vs `recordedChunks` split)
- First animation cluster timecode ≈ `PRE_ROLL_MS` (predictable for re-zeroing)

**Step 1: Add `_findClusterOffsetAtTime` helper**

Add this method right after `_getLastClusterTimecode` (before `_extractWebmHeader`):
```typescript
/**
 * Scan WebM clusters and return the byte offset of the FIRST cluster whose
 * Timecode element value is >= targetMs. Returns -1 if not found.
 * Used to trim the pre-roll phase from a continuous recording.
 */
private _findClusterOffsetAtTime(buffer: ArrayBuffer, targetMs: number): number {
  const data = new Uint8Array(buffer);
  for (let i = 0; i < data.length - 20; i++) {
    if (data[i] === 0x1F && data[i + 1] === 0x43 && data[i + 2] === 0xB6 && data[i + 3] === 0x75) {
      for (let j = i + 4; j < Math.min(i + 25, data.length - 5); j++) {
        if (data[j] === 0xE7) {
          const szByte = data[j + 1];
          if (szByte >= 0x81 && szByte <= 0x84) {
            const numBytes = szByte & 0x7F;
            let tc = 0;
            for (let b = 0; b < numBytes; b++) tc = (tc << 8) | data[j + 2 + b];
            if (tc >= targetMs) return i;
          }
          break;
        }
      }
      i += 3;
    }
  }
  return -1;
}
```

**Step 2: Rewrite the recording setup in `_startStudioRecordingLoop`**

Replace the current warmup/ondataavailable block (lines ~2805–2943). Key changes:

**Remove:**
```typescript
const ENCODER_WARMUP_MS = 2000;
// ...
let warmupBlob: Blob | null = null;
let warmupFlushed = false;

this.mediaRecorder.ondataavailable = (e) => {
  if (e.data.size === 0) return;
  if (!warmupFlushed) {
    warmupFlushed = true;
    warmupBlob = e.data;
  } else {
    this.recordedChunks.push(e.data);
  }
};
```

**Replace with:**
```typescript
const PRE_ROLL_MS = 2500; // wall-clock pre-roll for encoder warm-up (>= 2s recommended)

this.mediaRecorder.ondataavailable = (e) => {
  if (e.data.size > 0) this.recordedChunks.push(e.data);
};
```

**Step 3: Rewrite `onstop` handler**

Replace the current `onstop` logic (lines ~2841–2938) with:
```typescript
this.mediaRecorder.onstop = async () => {
  // ... (keep all the shadow/scene restore code unchanged) ...

  let outBlob: Blob;
  const finalDurationMs = durationMs;

  const allBufs = await Promise.all(this.recordedChunks.map(c => c.arrayBuffer()));
  const totalSize = allBufs.reduce((s, b) => s + b.byteLength, 0);
  const combined = new Uint8Array(totalSize);
  let writeOff = 0;
  for (const buf of allBufs) { combined.set(new Uint8Array(buf), writeOff); writeOff += buf.byteLength; }
  const combinedBuf = combined.buffer;

  // Extract EBML structural header (everything before first cluster)
  const rawHeaderBuf = this._extractWebmHeader(combinedBuf);

  // Find where animation clusters start (first cluster at t >= PRE_ROLL_MS)
  const animClusterOffset = this._findClusterOffsetAtTime(combinedBuf, PRE_ROLL_MS);

  if (animClusterOffset > 0) {
    const animBuf = combinedBuf.slice(animClusterOffset);
    const firstTc = this._getFirstClusterTimecode(animBuf);
    const adjustBy = firstTc > 0 ? firstTc : PRE_ROLL_MS;
    const adjAnim = this._adjustWebmClusterTimecodes(animBuf, adjustBy);
    const headerBuf = this._patchEbmlDuration(rawHeaderBuf, finalDurationMs);
    outBlob = new Blob([headerBuf, adjAnim], { type: getSupportedMimeType() });
  } else {
    // Fallback: no pre-roll boundary found — use full combined data
    outBlob = new Blob(this.recordedChunks, { type: getSupportedMimeType() });
  }

  const fixedBlob = await fixWebmDuration(outBlob, finalDurationMs, { logger: false });
  resolve(fixedBlob);
};
```

**Step 4: Rewrite the animate loop (Phase 1 → Phase 2)**

Replace the current phase tracking (lines ~2952–2062) with:
```typescript
// Phase tracking
let loopStart = -1;
let frameCount = -1;
let preRollStart = -1;    // wall-clock time when pre-roll began
let animationStarted = false;
let recordingStartTime = -1;

const animate = (timestamp: number) => {
  const now = performance.now();

  if (loopStart < 0) loopStart = timestamp;
  const targetFrame = Math.floor((timestamp - loopStart) / FRAME_INTERVAL_MS);
  if (targetFrame <= frameCount) {
    this.animationFrameId = requestAnimationFrame(animate);
    return;
  }
  frameCount = targetFrame;

  // ── Phase 1: Pre-roll (static frame, encoder warm-up) ──────────────────
  if (!animationStarted) {
    if (preRollStart < 0) preRollStart = now;
    renderFrame(easingFn(0));
    onProgress?.(0);
    if (now - preRollStart < PRE_ROLL_MS) {
      this.animationFrameId = requestAnimationFrame(animate);
      return;
    }
    animationStarted = true;
    recordingStartTime = now;
    // fall through to render first animation frame in this tick
  }

  // ── Phase 2: Animation ─────────────────────────────────────────────────
  const elapsedMs = now - recordingStartTime;

  if (this.isDisposed || elapsedMs >= durationMs) {
    renderFrame(easingFn(1));
    onProgress?.(100);
    this.animationFrameId = null;
    this.mediaRecorder?.stop();
    return;
  }

  const progress = Math.min(1, elapsedMs / durationMs);
  onProgress?.(Math.round(progress * 100));

  const hasSpinY = cue.spinSpeed > 0;
  const hasSpinX = (cue.spinSpeedX || 0) > 0;
  if (hasSpinY || hasSpinX) {
    this.spinCueInstances(
      hasSpinY ? cue.spinSpeed * 0.02 * spinPerFrame : 0,
      hasSpinX ? (cue.spinSpeedX || 0) * 0.02 * spinPerFrame : 0
    );
  }

  renderFrame(easingFn(progress));
  this.animationFrameId = requestAnimationFrame(animate);
};
```

**Step 5: Start MediaRecorder without timeslice**

Replace line 3061:
```typescript
// OLD:
this.mediaRecorder.start(ENCODER_WARMUP_MS);
// NEW:
this.mediaRecorder.start(); // no timeslice — single chunk on stop, cleanest for post-trim
```

**Step 6: Remove now-unused variables**

Remove `warmupFlushed` and `warmupBlob` declarations since they're no longer used. Also remove `encoderWarmupDone` from phase tracking (replaced by `animationStarted`).

**Step 7: Build and verify**

```bash
npm run build
```
Expected: 0 TypeScript errors.

**Step 8: Commit**

```bash
git add src/lib/three/extractor-scene-manager.ts
git commit -m "feat: wall-clock pre-roll replaces timeslice warmup for exact video duration

New approach:
- mediaRecorder.start() with no timeslice (single chunk on stop)
- Phase 1: render static frame for PRE_ROLL_MS (2500ms) wall-clock
- Phase 2: animate for exactly durationMs wall-clock
- onstop: find first cluster >= PRE_ROLL_MS, trim pre-roll, re-zero
- Result: estimated duration == final video duration, no 2s discrepancy

Adds _findClusterOffsetAtTime helper for binary cluster scanning.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Execution summary

Tasks are independent and can be done in order (1 → 2 → 3).
Task 3 is the most complex — if the binary trim fails (fallback fires), the video will still be usable but slightly longer than estimated.
Validation: build must pass after each task before committing.
