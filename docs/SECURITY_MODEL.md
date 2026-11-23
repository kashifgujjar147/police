# Security model

| Area | Implementation | Verified by |
|---|---|---|
| Tenant isolation | Scoped repositories inject `tenantId`; schema inventory with tenant-prefixed unique keys; boundary lint; out-of-scope ids return 404 | `security.test.ts` TR-001 (3,000+ cross-tenant requests, data fingerprint unchanged) |
| Authorisation | Deny by default; permission keys per route; hierarchy scope (assigned units + descendants); no granting of permissions you do not hold; Owner role only by transfer | TR-002 matrix (7 roles × 39 capabilities), route-metadata test |
| Passwords | scrypt (N=32768, r=8, p=3 by default; rehash on login when parameters change). Argon2id adapter via `PASSWORD_ALGO=argon2id` + optional `argon2` package. Min 10 chars (12 privileged), local breached list | FR-AUTH-006/002 test |
| MFA | TOTP (RFC 6238) mandatory for Owner, Admin and platform staff; secret AES-256-GCM encrypted; used codes not replayable; 10 single-use recovery codes; reset only by another admin | FR-AUTH-003 tests |
| Tokens | EdDSA (Ed25519) JWT, 15 min, `kid` rotation, only EdDSA accepted. Refresh tokens opaque, stored hashed, rotated on use; reuse of a rotated token revokes the whole family. Web: HttpOnly SameSite=Strict cookie + CSRF double submit | FR-AUTH-004/005 test |
| Sessions | Server-side; idle and absolute timeouts (web 12 h / 7 d, mobile 14 d / 30 d); revoked on password change/reset, MFA reset, offboarding, device revocation | same |
| Devices | Ed25519 key generated on the device; duty actions signed (method, path, body hash, timestamp); second device needs approval; revocation blocks the next request and closes tracking | FR-DEV test |
| Lockout and rate limits | 5 failures → 15 min lock; token buckets per class (login per IP and per account); SOS never limited (flagged when excessive) | FR-AUTH-006, rate-limit test |
| Input | Strict schemas: unknown fields rejected, `$`/dotted/prototype keys rejected, sizes bounded, 256 KB body limit | validation tests |
| Audit | Append-only per-tenant hash chain; before/after on changes; denials and failures recorded outside the rolled-back transaction; daily verification raises an Owner alert | FR-AUD tests (tampering detected) |
| Files | Declared type must match magic bytes; EXIF/XMP/IPTC stripped; random storage keys never exposed; 5-minute HMAC-signed download links issued after re-authorisation | retention/files test |
| Exports | CSV formula neutralisation; export job re-reads the requester's permissions and scope at run time | J9 |
| Secrets at rest | Contact details, TOTP secrets, checkpoint secrets, push tokens, integration configs encrypted (AES-256-GCM); token hashes only | log-hygiene test |
| Logs | JSON, redacting passwords, tokens, codes, signatures, coordinates | FR-NFR-004 test |
| Headers | CSP, X-Frame-Options DENY, nosniff, no-referrer, no-store on API, HSTS in production, CORS allow-list | HTTP test |
| Jobs | Payloads HMAC-signed; tampered jobs dead-lettered | durability test |
| Platform staff | No tenant permission keys. Read-only, scoped, time-boxed support grants approved by the Owner; break-glass (1 h) notifies the Owner; every access audited | FR-TEN test |
| Privacy | Location only inside a tracking session; notice acceptance gates tracking; every history view needs a purpose and is visible to the employee | J3, operations tests |

## Known limits
- Breached-password list is small (offline build). For production, replace `BREACHED_PASSWORDS` with a larger list or a k-anonymity check against a service you run.
- MongoDB database-role separation for append-only collections (application role without update/delete on audit collections) is documented here but must be configured by the operator: create an app user with `insert`/`find` on `audit_events`, `platform_audit_events`, `attendance_events`, `location_points`, `checkpoint_scans`, `geofence_events`, `incident_timeline`, `alert_timeline`, `assignment_history`, `location_access_log`, and a separate retention user with `remove`.
- No malware scanner is bundled; `app.services.scanner` is a port (connect ClamAV in production).
- `npm audit` and container scanning are in CI configuration but were not run here (no registry access).
- Rate-limit buckets are per process; behind several API instances, limits are per instance.
