# Runbook: backup and restore (RPO 15 min, RTO 4 h)

**Status:** scripts written; a restore drill has **not** been performed (no MongoDB in the build environment). Do one before go-live and record the timings below.

## Backup
```bash
# /etc/cron.d/smartforce360
*/15 * * * * sf  STORE=mongo MONGO_URL=... DATA_DIR=/srv/sf/data BACKUP_DIR=/var/backups/sf /opt/sf/infrastructure/backup/backup.sh >> /var/log/sf-backup.log 2>&1
```
- MongoDB: `mongodump --archive --gzip` (use `--oplog` against a dedicated backup member for point-in-time consistency).
- Files: tarball of `DATA_DIR/files`.
- Encrypt (age/gpg/KMS) before copying off-site. Keep 35 days. Alert if the log has no `backup ok` line for 30 minutes.

## Restore drill
1. Pick the latest archive pair. Note the time (RTO clock starts).
2. `MONGO_URL=... DATA_DIR=/srv/sf/restore ./infrastructure/backup/restore.sh db-<ts>.archive.gz files-<ts>.tar.gz smartforce360_restore`
3. `STORE=mongo MONGO_DB=smartforce360_restore npm run verify:restore` — verifies every tenant's audit hash chain and prints document counts per collection. Any chain break = do not switch.
4. Start one API against the restored database on a private port; sign in as a test user, open the command centre, run a report.
5. Switch `MONGO_DB` (or rename databases) and restart API and worker.
6. Record: archive age at failure (RPO), elapsed time (RTO), problems.

## File-store deployments
`backup.sh` copies `smartforce360.db.json` (written atomically on shutdown and periodically). Stop the server before restoring a file-store snapshot; `STORE=file DATA_DIR=... npm run verify:restore` works the same way.

| Drill date | Archive age | Time to restore | Chains OK | Notes |
|---|---|---|---|---|
| — | — | — | — | not yet performed |
