# Requirements Traceability Matrix (derived)

The RTM file named in the Master Development Prompt was not supplied, so this matrix was derived from PRD v2.1 (138 functional requirement IDs). `npm run trace` checks that every PRD ID appears here exactly once and that every cited test exists.

**Status key**

| Status | Meaning |
|---|---|
| **Verified** | Implemented and exercised by an automated test cited in the Evidence column (all tests pass in this build). |
| **Verified (browser)** | Exercised by the Playwright run against the built web portal (`npm run test:e2e:web`). |
| **Implemented** | Code exists and was checked by hand or indirectly; no dedicated automated test. |
| **Partial** | Some acceptance criteria met; the gap is stated in Notes. |
| **Unverified (device)** | Code written for the Expo app or an external service, but it could not be compiled or run in the build environment (no network, no devices). |
| **Not implemented** | Not built. Most are R2/ENT phase in the PRD; MVP gaps are called out. |

Evidence format: `file :: fragment of the test name`. Abbreviations: **U** `tests/unit/domain.test.ts`, **M** `tests/unit/mobile-core.test.ts`, **J** `tests/integration/journeys.test.ts`, **S** `tests/integration/security.test.ts`, **O** `tests/integration/operations.test.ts`, **H** `tests/integration/http.test.ts`, **W** `tests/e2e-web/run.ts`, **L** `tests/load/ingest-load.ts`.

| ID | Requirement (short) | Pri / Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| FR-TEN-001 | Tenant lifecycle states and effects | C / MVP | Verified | O :: FR-TEN-001..004; J :: J10 Offboard | Suspension keeps SOS and check-out for 24 h grace; Owner keeps export access. |
| FR-TEN-002 | Atomic, idempotent provisioning + onboarding checklist | H / MVP | Verified | O :: FR-TEN-001..004; J :: J1 Provision | Failure injected mid-provisioning leaves no partial tenant. |
| FR-TEN-003 | Support access only via approved, time-boxed, read-only grant | C / MVP | Verified | O :: FR-TEN-001..004 | Break-glass mode notifies the Owner; every access audited. |
| FR-TEN-004 | Platform console: tenants, state, plan, usage metadata only | H / MVP | Verified | O :: FR-TEN-001..004 | Web console in `admin.tsx` (Platform). |
| FR-TEN-005 | System health and integration configuration, secrets masked | H / MVP | Partial | O :: FR-TEN-001..004 | Health and masked integration status exist; only email (SMTP) and map tiles have adapters. Push/SMS show "not configured". |
| FR-AUTH-001 | Tenant-scoped username/email sign-in; activation without email | C / MVP | Verified | J :: J1 Provision; S :: FR-AUTH-006/002 lockout | Single-use, 72 h activation codes. |
| FR-AUTH-002 | Password hashing and policy (min length, breached list) | C / MVP | Partial | S :: FR-AUTH-006/002 lockout | Uses scrypt (memory-hard) by default; Argon2id adapter included but needs the optional `argon2` package (ADR-0005). Breached list is a small local list. |
| FR-AUTH-003 | Mandatory TOTP MFA for privileged roles; recovery codes | C / MVP | Verified | S :: FR-AUTH-003 MFA; U :: FR-AUTH-003 TOTP | No token issued before the second factor; replay of a used code rejected. |
| FR-AUTH-004 | 15-min access tokens; rotating refresh; reuse revokes family | C / MVP | Verified | S :: FR-AUTH-004/005 sessions | EdDSA JWT; web refresh token in HttpOnly cookie + CSRF double submit. |
| FR-AUTH-005 | List and revoke sessions/devices; effective next call | C / MVP | Verified | S :: FR-AUTH-004/005 sessions | |
| FR-AUTH-006 | Throttling and lockout; neutral errors | H / MVP | Verified | S :: FR-AUTH-006/002 lockout; O :: TS §9.1 rate limits | |
| FR-AUTH-007 | Password reset by single-use token; revokes sessions | H / MVP | Verified | S :: FR-AUTH-004/005 sessions | Also admin-issued one-time reset code. |
| FR-AUTH-008 | Security notifications (new device, MFA change…) | M / R2 | Not implemented | — | R2. Device-pending and break-glass notifications exist. |
| FR-AUTH-009 | Email verification; unverified address not used for reset | M / MVP | Verified | S :: FR-AUTH-004/005 sessions | |
| FR-RBAC-001 | Default roles per Appendix A; clone to customise | C / MVP | Verified | S :: TR-002 permission matrix; O :: FR-RBAC-002/003 hierarchy scope | 39 capabilities × 7 roles probed. |
| FR-RBAC-002 | Deny-by-default; tenant, permission, scope; out-of-scope = 404 | C / MVP | Verified | S :: TR-001 tenant isolation; O :: FR-RBAC-002/003 hierarchy scope | |
| FR-RBAC-003 | Role/scope changes effective on next API call and ≤ 60 s for realtime | H / MVP | Verified | O :: FR-RBAC-002/003 hierarchy scope | Realtime subscriptions re-checked every 10 s (code), not separately tested. |
| FR-RBAC-004 | Temporary delegation | M / R2 | Not implemented | — | R2. |
| FR-RBAC-005 | Access explainer | L / R2 | Not implemented | — | R2. |
| FR-ORG-001 | Configurable hierarchy; move recomputes paths; no cycles | C / MVP | Verified | O :: FR-ORG-001 hierarchy | Merge also supported. |
| FR-ORG-002 | Staff with tenant-unique codes and lifecycle | C / MVP | Verified | J :: J10 Offboard; O :: FR-ORG-003 staff import | |
| FR-ORG-003 | CSV import with preview, per-row report, idempotent re-run | H / MVP | Verified | O :: FR-ORG-003 staff import | 1,000-row timing not measured separately. |
| FR-ORG-004 | Offboarding revokes access, closes tracking, flags future duties | C / MVP | Verified | J :: J10 Offboard | |
| FR-ORG-005 | Posts belong to one unit; optional location | C / MVP | Verified | O :: FR-GEO-001..003 geofence; J :: J1 Provision | |
| FR-ORG-006 | Teams; person may be in several teams | M / MVP | Implemented | — | API + web; team filter on staff list and command centre (`teamId`). |
| FR-ORG-007 | Qualifications / certifications | L / R2 | Not implemented | — | R2. |
| FR-ORG-008 | Profile with role-based masking of sensitive fields; bulk update audit | M / MVP | Partial | O :: FR-RBAC-002/003 hierarchy scope | Contact details encrypted and masked by role; bulk update writes one audit summary. Profile photo upload class exists but no photo UI. |
| FR-DUTY-001 | Shifts in site timezone; DST-safe recurrence; overnight | C / MVP | Verified | U :: FR-DUTY-001 weekly shifts; U :: FR-DUTY-001 overnight; O :: FR-DUTY-001/002 planning | |
| FR-DUTY-002 | Assignments; overlap policy Block/Warn/Allow | C / MVP | Verified | O :: FR-DUTY-001/002 planning | Warn confirmation recorded in audit. |
| FR-DUTY-003 | Versioned rosters, immutable versions, 409 on concurrent publish | C / MVP | Verified | J :: J2 Plan and publish | |
| FR-DUTY-004 | Notify on publish/revision/cancel; acknowledgement + reminders | H / MVP | Verified | J :: J2 Plan and publish | Reminder scheduler implemented; reminder timing not separately tested. |
| FR-DUTY-005 | Leave / unavailability | M / R2 | Not implemented | — | R2. |
| FR-DUTY-006 | Shift swap and handover | M / R2 | Not implemented | — | R2. |
| FR-DUTY-007 | Roster templates / copy-forward | L / R2 | Not implemented | — | R2. Recurring shifts cover the common case. |
| FR-DUTY-008 | Minimum staffing; coverage gaps | H / MVP | Verified | O :: FR-DUTY-001/002 planning | Role/qualification rules not implemented (qualifications are R2). |
| FR-ATT-001 | Server-validated start/end against window and geofence policy | C / MVP | Verified | U :: FR-ATT-001 duty start window; O :: FR-ATT-001/002/004 | |
| FR-ATT-002 | Offline start, synced once, rejection with reason | C / MVP | Verified | J :: J4 Offline duty; M :: FR-SYN-001..004 offline duty | |
| FR-ATT-003 | Breaks as separate events; policy | H / MVP | Verified | J :: J3 Work a duty | Break-count overrun flagged. |
| FR-ATT-004 | Missed check-out policy Remain open / Auto-close / Flag | H / MVP | Verified | O :: FR-ATT-001/002/004 | |
| FR-ATT-005 | Corrections append events; original preserved; self-approval blocked | C / MVP | Verified | J :: J8 Correct attendance | |
| FR-ATT-006 | Duty summary with basis labels and missing evidence | H / MVP | Verified | J :: J3 Work a duty; J :: J8 Correct attendance | |
| FR-ATT-007 | Supervisor review: approve (locks) or return | H / MVP | Verified | J :: J8 Correct attendance | |
| FR-LOC-001 | Location only inside a Tracking Session | C / MVP | Verified | J :: J3 Work a duty; S :: FR-DEV-001..003 devices | Also enforced on the device (mobile-core refuses points without a session). |
| FR-LOC-002 | Tenant-configurable sampling profile delivered to device | H / MVP | Partial | M :: TS §14 device bits | Tenant-wide profile and break mode; per-post override not implemented. Config is HMAC-signed. |
| FR-LOC-003 | recordedAt / receivedAt / effective time; late window | C / MVP | Verified | O :: FR-LOC-003/006/007 | |
| FR-LOC-004 | Server-side freshness Live/Recent/Stale/Unknown | C / MVP | Verified | U :: FR-LOC-004 freshness; J :: J5 Supervise live | |
| FR-LOC-005 | Duplicate / out-of-order points | C / MVP | Verified | J :: J3 Work a duty; O :: FR-GEO-001..003 geofence | Unique (device, session, seq) key. |
| FR-LOC-006 | History needs permission + purpose; every access logged | C / MVP | Verified | O :: FR-LOC-003/006/007; W :: location history requires a purpose | |
| FR-LOC-007 | Review signals with facts; never findings | H / MVP | Verified | U :: FR-LOC-007 review signals; O :: FR-LOC-003/006/007 | |
| FR-LOC-008 | Latest-state projection for the live map | H / MVP | Verified | L :: locationsLatestMs; J :: J5 Supervise live | In-memory p95 5.7 ms at 1,000 staff; must be re-measured on MongoDB. |
| FR-GEO-001 | Circle/polygon, validated, versioned | C / MVP | Verified | U :: FR-GEO-001 invalid; O :: FR-GEO-001..003 geofence | Web UI creates circles; polygons via API. |
| FR-GEO-002 | Accuracy-aware evaluation with hysteresis | C / MVP | Verified | U :: noisy track fixture; O :: FR-GEO-001..003 geofence | |
| FR-GEO-003 | Events with confidence and policy version; exception alert | H / MVP | Verified | O :: FR-GEO-001..003 geofence | |
| FR-CHK-001 | Checkpoints with unguessable ids; reissue | C / MVP | Verified | O :: FR-CHK-002..004 checkpoints | QR in app. NFC: method recorded, no NFC reader code in the app. |
| FR-CHK-002 | Scan bound to assignment/device/staff; reason codes | C / MVP | Verified | U :: FR-CHK-002 every checkpoint; O :: FR-CHK-002..004 checkpoints | |
| FR-CHK-003 | Replay protection; rotating codes | H / MVP | Verified | U :: FR-CHK-003 rotating; O :: FR-CHK-002..004 checkpoints | |
| FR-CHK-004 | Missed checkpoints by scheduled evaluator | H / MVP | Verified | O :: FR-CHK-002..004 checkpoints | |
| FR-CHK-005 | Offline scans validated on sync with both times | H / MVP | Verified | J :: J4 Offline duty | |
| FR-ALR-001 | Configurable rules; changes affect future evaluation | C / MVP | Verified | J :: J6 Handle an exception; S :: FR-AUD-001/002/003 audit | |
| FR-ALR-002 | Deduplication by type/subject/window | C / MVP | Verified | J :: J6 Handle an exception | |
| FR-ALR-003 | Escalation, once per step, survives restart | H / MVP | Verified | J :: J6 Handle an exception; O :: TS §20, FR-ALR-004 durability | |
| FR-ALR-004 | Delivery attempts and provider results recorded | H / MVP | Partial | O :: FR-NOT-001/002 | In-app delivery and SMTP attempts recorded; no push/SMS provider. |
| FR-ALR-005 | Quiet hours / per-user preferences | M / R2 | Not implemented | — | R2. |
| FR-SOS-001 | Hold-to-confirm | C / MVP | Verified | M :: FR-SOS-001..004 SOS from the device | Device UI unverified on hardware. |
| FR-SOS-002 | Truthful delivery states on device and console | C / MVP | Verified | J :: J7 SOS; M :: FR-SOS-001..004 SOS from the device | |
| FR-SOS-003 | Bounded retry; fallback instructions | C / MVP | Verified | M :: FR-SOS-001..004 SOS from the device | |
| FR-SOS-004 | Escalation until a person acknowledges | C / MVP | Verified | J :: J7 SOS | 60 s re-notify, 120 s Supervisor, 300 s Commander. |
| FR-SOS-005 | Cancel within hold window sends nothing; later cancel is a request | H / MVP | Verified | M :: FR-SOS-001..004 SOS from the device | |
| FR-SOS-006 | Drill mode | M / R2 | Not implemented | — | R2. |
| FR-INC-001 | Lifecycle with enforced transitions | C / MVP | Verified | U :: FR-INC-001 / PRD §5.2 state machines; J :: J7 SOS | |
| FR-INC-002 | Non-emergency reports with types and attachments | H / MVP | Verified | O :: FR-PRV-004/005, FR-INC-005 retention | Attachments type-checked and metadata-stripped. No malware scanner bundled (port exists). |
| FR-INC-003 | Responder assignment | H / MVP | Verified | J :: J7 SOS | |
| FR-INC-004 | Closure needs resolution; append-only timeline | H / MVP | Verified | J :: J7 SOS | |
| FR-CMD-001 | Map and list views with identical filters | C / MVP | Verified (browser) | W :: command centre lists people | |
| FR-CMD-002 | Every marker/row shows time, age, freshness, accuracy | C / MVP | Verified (browser) | W :: command centre lists people; U :: FR-CMD-001/002 display | Stale markers hollow + dashed; never shown as on duty. |
| FR-CMD-003 | List fully functional without map tiles | C / MVP | Verified (browser) | W :: command centre lists people | No tile provider is bundled; grid fallback by default. |
| FR-CMD-004 | Staff detail panel; out-of-scope = 404 | H / MVP | Partial | O :: FR-RBAC-002/003 hierarchy scope | Panel shows state, freshness, times, battery, accuracy; assignment/alerts links are on other screens. |
| FR-CMD-005 | Realtime status visible; catch-up after reconnect | C / MVP | Verified | H :: TS §23/§10 HTTP adapter; J :: J5 Supervise live | |
| FR-CMD-006 | Marker clustering / level of detail | M / MVP | Implemented | — | Grid clustering above 30 markers; SOS and the selected person are never merged. 30 fps target not measured. |
| FR-CMD-007 | Overview dashboard with freshness | H / MVP | Verified (browser) | W :: commander signs in | |
| FR-MOB-001 | My Duty offline (last-synced) | C / MVP | Unverified (device) | — | `apps/mobile/src/App.tsx`. API `/me/duty` verified in J2. |
| FR-MOB-002 | Persistent tracking indicator | C / MVP | Unverified (device) | — | Android foreground-service notification + in-app banner (code only). |
| FR-MOB-003 | Permission onboarding before OS prompts | C / MVP | Unverified (device) | — | Explanation card + settings link (code only). |
| FR-MOB-004 | Sync status screen | C / MVP | Partial | M :: FR-SYN-001..004 offline duty | Queue counts/oldest age verified in mobile-core; shown as an in-app banner, not a dedicated screen. |
| FR-MOB-005 | Battery behaviour measured on devices | H / MVP | Not implemented | — | Needs real devices (PRD §12.2). |
| FR-MOB-006 | Recovery after restart/kill/reboot | C / MVP | Partial | M :: FR-SYN-001..004 offline duty | Queue survives a restart (verified with persisted storage); OS-kill/reboot behaviour needs devices. |
| FR-MOB-007 | Android first; iOS per matrix | H / MVP | Unverified (device) | — | Expo source targets both; no build produced. |
| FR-MOB-008 | Push via provider adapter | H / MVP | Not implemented | — | MVP gap pending D-09 (provider choice). In-app notifications + realtime are the source of truth. |
| FR-SYN-001 | Idempotent client events; conflict on reuse | C / MVP | Verified | J :: J4 Offline duty; O :: FR-ATT-001/002/004 | |
| FR-SYN-002 | Ordered per-event results; rejections stay visible | C / MVP | Verified | J :: J4 Offline duty; M :: FR-SYN-001..004 offline duty | |
| FR-SYN-003 | Server time authoritative; skew flagged | H / MVP | Verified | O :: FR-ATT-001/002/004 | |
| FR-PRV-001 | Employee self-view | C / MVP | Verified | O :: FR-LOC-003/006/007 | Web "My data"; mobile view unverified. |
| FR-PRV-002 | Versioned notice; acceptance gates tracking | C / MVP | Verified | O :: FR-ATT-001/002/004 | |
| FR-PRV-003 | Subject export / deletion with completion record | H / MVP | Verified | J :: J10 Offboard | |
| FR-PRV-004 | Retention schedule with dry run | C / MVP | Verified | O :: FR-PRV-004/005, FR-INC-005 retention | |
| FR-PRV-005 | Legal hold | H / MVP | Verified | O :: FR-PRV-004/005, FR-INC-005 retention; J :: J10 Offboard | |
| FR-PRV-006 | No covert tracking | C / MVP | Verified | J :: J3 Work a duty | No hidden mode exists; tracking indicator in app (device-unverified). |
| FR-AUD-001 | Audit coverage for sensitive actions | C / MVP | Verified | S :: route metadata; S :: FR-AUD-001/002/003 audit | Every route declares an audit action or a written justification. |
| FR-AUD-002 | Append-only, hash-chained, verified daily | H / MVP | Verified | U :: FR-AUD-002 hash chain; S :: FR-AUD-001/002/003 audit | DB-role separation documented for MongoDB, not testable here. |
| FR-AUD-003 | Search/filter/export; reads of the audit log are audited | H / MVP | Verified | S :: FR-AUD-001/002/003 audit; W :: owner signs in with MFA | |
| FR-RPT-001 | Report catalogue | C / MVP | Verified | J :: J9 Review and report; J :: J7 SOS | 11 reports. |
| FR-RPT-002 | Basis labels on values | H / MVP | Verified | J :: J9 Review and report | |
| FR-RPT-003 | CSV export, formula-safe, short-lived audited link | C / MVP | Verified | J :: J9 Review and report; U :: FR-RPT-003 CSV | PDF export not implemented (browser print stylesheet only). |
| FR-RPT-004 | Scheduled reports | M / R2 | Not implemented | — | R2. |
| FR-RPT-005 | No performance ranking | H / MVP | Implemented | — | No report ranks individuals; definitions in `modules/records`. |
| FR-SET-001 | Tenant settings versioned with platform bounds | H / MVP | Verified | O :: FR-SET-001, TS §8.5 | |
| FR-SET-002 | Catalogues EN/AR; archived values remain valid | M / MVP | Verified | O :: FR-NOT-001/002 | |
| FR-SET-003 | Terminology labels | M / MVP | Partial | O :: FR-NOT-001/002 | Stored and editable; the web UI uses them in a few places only. |
| FR-SET-004 | Branding | L / R2 | Not implemented | — | R2. |
| FR-SUB-001 | Plan limits; never block SOS/check-out | H / MVP | Verified | O :: FR-TEN-001..004 | |
| FR-SUB-002 | Usage snapshots | M / MVP | Implemented | — | Scheduler + `/tenant/usage`; values shown in console. |
| FR-SUB-003 | Billing adapter | L / ENT | Not implemented | — | ENT. No payment code exists. |
| FR-SUB-004 | Manual plan assignment, audited | M / MVP | Verified | O :: FR-TEN-001..004 | |
| FR-DEV-001 | Device key binding; second device needs approval | C / MVP | Verified | S :: FR-DEV-001..003 devices | |
| FR-DEV-002 | Revocation blocks access, closes tracking | C / MVP | Verified | S :: FR-DEV-001..003 devices | |
| FR-DEV-003 | Minimum app version enforced | H / MVP | Verified | S :: FR-DEV-001..003 devices | SOS exempt. |
| FR-DEV-004 | Integrity signals recorded, never blocking | M / MVP | Implemented | — | Heartbeat accepts signals; shown in device list. |
| FR-DEV-005 | Device health reporting | H / MVP | Implemented | — | Heartbeat + low-battery alert (alert covered in security fixture). |
| FR-I18N-001 | English and Arabic with RTL | C / MVP | Verified (browser) | W :: Arabic switches | Arabic copy needs native review (PRD L2). |
| FR-I18N-002 | Locale-aware dates/numbers in tenant timezone | H / MVP | Partial | W :: report runs with as-of | Week start/weekend stored; not used by a calendar view (planner is a list). |
| FR-I18N-003 | New languages by resource files | M / R2 | Implemented | — | Dictionary-based; adding a locale needs a resource object. |
| FR-I18N-004 | Mixed Arabic/Latin identifiers render correctly | M / MVP | Partial | — | Codes rendered with `unicode-bidi: isolate`; no bidi fixture test. |
| FR-A11Y-001 | WCAG 2.2 AA for core web flows | H / MVP | Partial | W :: login page renders and is accessible | Built-in checks (labels, names, one h1, lang); no axe-core run and no manual audit. |
| FR-A11Y-002 | Mobile screen reader support | H / MVP | Unverified (device) | — | Accessibility roles/labels in source. |
| FR-A11Y-003 | Design tokens | M / MVP | Implemented | — | CSS custom properties in `apps/web/src/styles.css`. |
| FR-NFR-001 | Availability target 99.5 % | H / MVP | Not implemented | — | Operational; depends on deployment. Health/readiness endpoints exist. |
| FR-NFR-002 | RPO 15 min / RTO 4 h with restore drill | C / MVP | Partial | — | Backup/restore scripts and `npm run verify:restore` written; no drill performed. |
| FR-NFR-003 | Performance targets | H / MVP | Partial | L :: locationsLatestMs | Measured in-memory only (see TEST_RESULTS.md). |
| FR-NFR-004 | Observability without sensitive data in logs | H / MVP | Verified | S :: FR-NFR-004 log hygiene; H :: TS §23/§10 HTTP adapter | |
| FR-NFR-005 | Dependency/container scanning; terminology | H / MVP | Partial | — | `npm run lint:terms` passes; `npm audit` in CI config, not run (no registry access). |
| FR-NFR-006 | Versioned API; OpenAPI | M / MVP | Implemented | — | `/api/v1`; `docs/openapi.json` generated from the route registry. |
| FR-NFR-007 | Capacity target (D-11) load test | H / MVP | Partial | L :: locationsLatestMs | In-process only; 3× target test needs the real stack. |
| FR-ENT-001 | SSO | M / ENT | Not implemented | — | ENT. |
| FR-ENT-002 | Public API keys and webhooks | L / ENT | Not implemented | — | ENT. |
| FR-ENT-003 | Per-unit retention, data residency | L / ENT | Not implemented | — | ENT. |
| FR-EXP-001 | Tenant export package | H / MVP | Verified | J :: J10 Offboard | JSON Lines per collection + manifest with checksums; secrets excluded. |
| FR-EXP-002 | Offboarding: grace period, legal hold, certificate | H / MVP | Verified | J :: J10 Offboard | |
| FR-SUP-001 | In-app help, support contact, diagnostics bundle | M / MVP | Verified (browser) | W :: help page offers support contact | Web only; tenant-specific support contact field not configurable. |
