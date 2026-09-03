#!/usr/bin/env bash
# Entrypoint for the GPU render worker.
#
# Picks a mode from the environment so one image serves every provider:
#   RunPod Serverless  → poll RunPod's queue      (default when its env exists)
#   Beam / Modal / box → HTTP server on $PORT     (WORKER_MODE=serve)
#   one-shot / local   → render one job and exit  (WORKER_MODE=job)
set -euo pipefail

log() { echo "[entrypoint] $*"; }

# Report the GPU the host injected. If this prints nothing, the container was
# started without --gpus / without the nvidia runtime, and every render will
# silently fall back to CPU — worth catching here rather than in a slow render.
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader || true
else
  log "WARNING: nvidia-smi not found — no GPU visible to this container"
fi

MODE="${WORKER_MODE:-auto}"

if [ "$MODE" = "auto" ]; then
  if [ -n "${RUNPOD_WEBHOOK_GET_JOB:-}" ]; then
    MODE="runpod"
  elif [ -n "${PORT:-}" ]; then
    MODE="serve"
  else
    MODE="job"
  fi
fi

log "mode: $MODE"

# Chrome's GL stack wants an X display even in headless=new on some drivers;
# Xvfb is cheap insurance and costs nothing when unused.
if [ "${USE_XVFB:-1}" = "1" ] && command -v xvfb-run >/dev/null 2>&1; then
  RUNNER=(xvfb-run -a --server-args="-screen 0 1920x1080x24")
else
  RUNNER=()
fi

case "$MODE" in
  runpod) exec "${RUNNER[@]}" node runpod-handler.mjs ;;
  serve)  exec "${RUNNER[@]}" node serve.mjs ;;
  job)    exec "${RUNNER[@]}" node worker.mjs "${1:-}" ;;
  *)      log "unknown WORKER_MODE: $MODE"; exit 1 ;;
esac
