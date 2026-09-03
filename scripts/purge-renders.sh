#!/usr/bin/env bash
#
# Deletes render output past its retention window (24h by default).
#
# Render results are a delivery buffer, not an archive: one 1920x1080 studio
# clip is tens of MB and a batch queues one job per product, so without this
# Storage fills with files nobody will open again. Everything it deletes is
# regenerable — the job payload is frozen, so re-running reproduces the same
# pixels.
#
# INSTALL ON THE VPS
#
#   1. Put this file somewhere stable and make it executable:
#        install -m 755 scripts/purge-renders.sh /usr/local/bin/purge-renders.sh
#
#   2. Give it the app URL and the worker secret. Two options — pick ONE:
#
#      a) An env file (preferred; keeps the secret out of the crontab):
#           printf 'APP_BASE_URL=https://3d.next.lc\nRENDER_WORKER_SECRET=xxxx\n' \
#             > /etc/render-purge.env
#           chmod 600 /etc/render-purge.env
#
#      b) The app's own .env — pass its path as PURGE_ENV_FILE.
#
#   3. crontab -e, then add (hourly, at :17 to avoid the busy top of the hour):
#
#        17 * * * * PURGE_ENV_FILE=/etc/render-purge.env /usr/local/bin/purge-renders.sh >> /var/log/render-purge.log 2>&1
#
#      Cron runs with a near-empty environment and no shell profile, which is
#      why the env file is read here rather than assumed to be exported.
#
#   4. Verify without waiting an hour:
#        PURGE_ENV_FILE=/etc/render-purge.env /usr/local/bin/purge-renders.sh
#
# Nothing breaks if this never runs: the app also sweeps in the background when
# a render is queued. That backstop only fires when somebody renders, though,
# so the last batch of the day would sit until the next one.

set -euo pipefail

ENV_FILE="${PURGE_ENV_FILE:-}"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  # `set -a` exports everything the file defines, so plain KEY=value works.
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

APP_BASE_URL="${APP_BASE_URL:-${RENDER_APP_BASE_URL:-}}"
SECRET="${RENDER_WORKER_SECRET:-}"

if [ -z "$APP_BASE_URL" ] || [ -z "$SECRET" ]; then
  echo "$(date -Is) [render-purge] ERROR: APP_BASE_URL and RENDER_WORKER_SECRET must be set" >&2
  echo "  (export them, or point PURGE_ENV_FILE at a file that defines them)" >&2
  exit 1
fi

URL="${APP_BASE_URL%/}/api/render-worker/purge?limit=200"

# One run is bounded to `limit` jobs so a single request cannot run for
# minutes. After downtime the backlog can exceed that, and the response's
# `more` flag says so — loop until it clears, with a hard stop so a persistent
# failure cannot spin.
MAX_ROUNDS="${PURGE_MAX_ROUNDS:-20}"
round=0

while [ "$round" -lt "$MAX_ROUNDS" ]; do
  round=$((round + 1))

  # --fail-with-body: non-2xx exits non-zero but still prints the server's
  # message, so the log says WHY (401 = secret mismatch, 503 = secret unset on
  # the app side) instead of just failing silently.
  if ! BODY=$(curl -sS --max-time 300 --fail-with-body \
                -X POST \
                -H "Authorization: Bearer $SECRET" \
                "$URL"); then
    echo "$(date -Is) [render-purge] request failed: ${BODY:-no response}" >&2
    exit 1
  fi

  echo "$(date -Is) [render-purge] $BODY"

  # No jq dependency: the flag is a plain boolean in the JSON body.
  case "$BODY" in
    *'"more":true'*) continue ;;
    *) break ;;
  esac
done

if [ "$round" -ge "$MAX_ROUNDS" ]; then
  echo "$(date -Is) [render-purge] stopped after $MAX_ROUNDS rounds with work remaining" >&2
fi
