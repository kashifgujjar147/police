#!/usr/bin/env sh
# Restore drill (RTO target 4 h). Restores into a SEPARATE database first; verify, then switch MONGO_DB.
# Usage: restore.sh <db-archive> <files-tar.gz> <target-db-name>
set -eu
mongorestore --uri="$MONGO_URL" --archive="$1" --gzip --nsFrom="${MONGO_DB:-smartforce360}.*" --nsTo="$3.*"
mkdir -p "$DATA_DIR" && tar -xzf "$2" -C "$DATA_DIR"
echo "Restored to $3. Now: MONGO_DB=$3 npm run verify:restore  (checks audit chains and counts), then switch traffic."
