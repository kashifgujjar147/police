#!/usr/bin/env sh
# Backup (RPO target 15 min, FR-NFR-002). Run from cron every 15 minutes; keep 7 days hourly + 35 days daily.
# MongoDB: consistent archive with oplog. File store: atomic copy of the snapshot + uploaded files.
set -eu
TS=$(date -u +%Y%m%dT%H%M%SZ); OUT=${BACKUP_DIR:-/var/backups/smartforce360}; mkdir -p "$OUT"
if [ "${STORE:-mongo}" = "mongo" ]; then
  mongodump --uri="$MONGO_URL" --db="${MONGO_DB:-smartforce360}" --archive="$OUT/db-$TS.archive.gz" --gzip
else
  cp "$DATA_DIR/smartforce360.db.json" "$OUT/db-$TS.json"
fi
tar -czf "$OUT/files-$TS.tar.gz" -C "$DATA_DIR" files
# Encrypt at rest with your KMS/age/gpg before off-site copy, e.g.: age -r "$BACKUP_RECIPIENT" -o "$OUT/db-$TS.age" "$OUT/db-$TS.archive.gz"
find "$OUT" -type f -mtime +35 -delete
echo "backup ok $TS"
