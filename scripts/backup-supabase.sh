#!/bin/bash
# ============================================================
# Supabase Daily Backup Script
# VPS path:  /root/supabase/docker
# Strategy:  overwrite latest backup each run (no accumulation)
# Cron:      0 2 * * * /root/supabase/docker/backup-supabase.sh
# ============================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────
SUPABASE_DIR="${SUPABASE_DIR:-/root/supabase/docker}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/supabase}"

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-supabase-db}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-postgres}"

STORAGE_PATH="${SUPABASE_DIR}/volumes/storage"
LOG_FILE="${BACKUP_DIR}/backup.log"

# ── Helpers ───────────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
die() { log "ERROR: $*"; exit 1; }

# ── Pre-flight checks ─────────────────────────────────────────
mkdir -p "$BACKUP_DIR"

command -v docker >/dev/null 2>&1 || die "docker not found"
docker ps --filter "name=${POSTGRES_CONTAINER}" --format "{{.Names}}" | grep -q "${POSTGRES_CONTAINER}" \
  || die "Container '${POSTGRES_CONTAINER}' is not running"

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

log "=== Supabase backup started ==="

# ── 1. Database backup ────────────────────────────────────────
log "Dumping database '${POSTGRES_DB}' from container '${POSTGRES_CONTAINER}'..."
docker exec "${POSTGRES_CONTAINER}" \
  pg_dump -U "${POSTGRES_USER}" --no-password "${POSTGRES_DB}" \
  | gzip > "${TEMP_DIR}/db_latest.sql.gz" \
  || die "pg_dump failed"

DB_SIZE=$(du -sh "${TEMP_DIR}/db_latest.sql.gz" | cut -f1)
log "Database dump complete (${DB_SIZE})"

# ── 2. Storage files backup ───────────────────────────────────
if [ -d "$STORAGE_PATH" ]; then
  log "Backing up storage from '${STORAGE_PATH}'..."
  tar -czf "${TEMP_DIR}/storage_latest.tar.gz" -C "$STORAGE_PATH" . \
    || die "Storage tar failed"
else
  # Fallback: inspect actual mount from supabase-storage container
  ACTUAL_STORAGE=$(docker inspect supabase-storage \
    --format '{{range .Mounts}}{{if eq .Destination "/var/lib/storage"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
  [ -n "$ACTUAL_STORAGE" ] || die "Cannot find storage path. Set STORAGE_PATH manually."
  log "Backing up storage from detected path '${ACTUAL_STORAGE}'..."
  tar -czf "${TEMP_DIR}/storage_latest.tar.gz" -C "$ACTUAL_STORAGE" . \
    || die "Storage tar failed"
fi

STORAGE_SIZE=$(du -sh "${TEMP_DIR}/storage_latest.tar.gz" | cut -f1)
log "Storage backup complete (${STORAGE_SIZE})"

# ── 3. Atomic replace — only swaps if both succeeded ─────────
log "Replacing previous backup files..."
mv -f "${TEMP_DIR}/db_latest.sql.gz"      "${BACKUP_DIR}/db_latest.sql.gz"
mv -f "${TEMP_DIR}/storage_latest.tar.gz" "${BACKUP_DIR}/storage_latest.tar.gz"

date '+%Y-%m-%d %H:%M:%S' > "${BACKUP_DIR}/last_backup_at.txt"

log "=== Backup complete ==="
log "  DB:      ${BACKUP_DIR}/db_latest.sql.gz  (${DB_SIZE})"
log "  Storage: ${BACKUP_DIR}/storage_latest.tar.gz  (${STORAGE_SIZE})"
log "  Disk used: $(du -sh ${BACKUP_DIR} | cut -f1)"
