# SmartForce 360: Mukammal Guide (A se Z) aur Testing Manual

> Yeh guide batati hai ke website **kya hai**, **kaise kaam karti hai**, **har feature kya karta hai**, aur **har feature ko kaise test karna hai**.
> Button aur page ke naam bilkul waise likhe hain jaise website par English mein dikhte hain.
> Tareekh: 13 Nov 2026 · Abhi local "simple mode" chal raha hai (2FA band). Deploy se pehle kya badalna hai, woh aakhri hisse mein hai.

---

## Fehrist
1. [Website ka kaam kya hai](#1-website-ka-kaam-kya-hai)
2. [Website kaise kaam karti hai (andar ka nizaam)](#2-website-kaise-kaam-karti-hai)
3. [Kaun kaun log istemal karte hain (Roles)](#3-roles-kaun-kya-kar-sakta-hai)
4. [Shuru kaise karein (server chalana, login, demo data)](#4-shuru-kaise-karein)
5. [Platform (Super Admin) ke features aur testing](#5-platform-super-admin)
6. [Organization ke features aur testing (har page)](#6-organization-ke-features-har-page)
7. [Field staff (mobile) ka kaam aur testing](#7-field-staff-mobile)
8. [Roles ki permission testing](#8-roles-ki-permission-testing)
9. [Poora kaam ek saath: end-to-end test kahani](#9-end-to-end-test-kahani)
10. [Automated tests (commands)](#10-automated-tests)
11. [Aam masle aur hal](#11-aam-masle-aur-hal)
12. [Deploy se pehle zaroori badlav](#12-deploy-se-pehle)
13. [Testing checklist (tick karne ke liye)](#13-testing-checklist)

---

## 1. Website ka kaam kya hai

**SmartForce 360** ek **Field Force Management** system hai, yani un companies ke liye jin ke log **field mein duty** karte hain: security guards, patrol teams, field technicians waghera.

Is se company ye sab kar sakti hai:

| Kaam | Matlab |
|---|---|
| **Duty plan karna** | Kaun, kis jagah (post), kis waqt (shift) duty karega |
| **Attendance** | Staff ne duty kab shuru ki, break, kab khatam ki: sab record |
| **Live location** | Duty ke dauran staff kahan hai, map par (sirf duty ke waqt, privacy ke saath) |
| **Geofence** | Post ke ird gird hadd; bahar jaye to alert |
| **Checkpoints** | Patrol ke dauran QR code scan karna, saabit karne ke liye ke banda wahan gaya |
| **Alerts** | Der se aana, checkpoint miss, location band, battery kam, SOS: system khud alert banata hai |
| **SOS / Emergency** | Field banda ek button se emergency bhejta hai; control room ko foran pata chalta hai |
| **Incidents** | Waqiat report karna aur un ka record (dispatch, on scene, closed) |
| **Reports** | 11 reports (attendance, late, absences, SOS response time waghera) aur CSV export |
| **Audit log** | Har ahem kaam ka record, jise koi chhed nahi sakta |
| **Multi-company (SaaS)** | Ek hi system mein bohot si companies; har company ka data alag aur mehfooz |

**Do hisse hain:**
- **Platform (Super Admin):** aap, yani system ke maalik. Companies banate aur sambhalte hain.
- **Organization (company):** har company ka Owner/Admin/Supervisor apni team chalata hai.

---

## 2. Website kaise kaam karti hai

```
 Browser (website)  ──►  API Server (Node.js)  ──►  Database (MongoDB Atlas)
                            │
 Mobile app (field) ────────┤   background worker: alerts, escalation, reports, cleanup
                            │
                     Live updates (realtime) browser ko wapas
```

| Hissa | Kya karta hai | Kahan hai |
|---|---|---|
| **Website (web portal)** | Admin, supervisor, control room ka interface | `apps/web` (build ho kar `apps/web/dist`) |
| **API server** | Saari logic: login, permissions, data save, alerts | `apps/api`, `modules/*` |
| **Database** | Saara data | Aap ke `.env` ke mutabiq **MongoDB Atlas** (`cluster0`, db `smartforce360`) |
| **Background worker** | Alerts check karna, SOS escalation, reports/exports banana, purana data saaf karna | Server ke andar hi chalta hai |
| **Mobile app** | Field staff ke liye: duty start/end, GPS, QR scan, SOS | `apps/mobile` (**abhi build nahi hui**) |
| **Field simulator** | Mobile app ki jagah testing ke liye "nakli phone" | `tools/field-simulator.ts` |

**Security ke usool (har jagah lagu):**
- Har company ka data **alag**; ek company doosri ka data kabhi nahi dekh sakti.
- Har banda sirf woh dekhta hai jis ki us ke **role** mein ijazat hai.
- Location **sirf duty ke dauran** li jaati hai, aur history dekhne ke liye **wajah (purpose)** likhni padti hai.
- Ahem kaam (suspend, delete, settings) par **reason** maanga jata hai, jo audit log mein jata hai.

---

## 3. Roles: kaun kya kar sakta hai

### Platform level
| Role | Kaam |
|---|---|
| **Super Admin** | Companies banana, suspend/resume/archive, plan dena, system health, usage, support access maangna. **Company ke andar ka data khud nahi dekh sakta** (sirf Owner ki approval se, read-only). |

### Company (organization) level (7 roles)
| Role | Kya kar sakta hai |
|---|---|
| **Organisation Owner** | Sab kuch: settings, roles, staff, billing/plan dekhna, company export/delete, support approval, legal hold |
| **Organisation Admin** | Owner jaisa, siwaye company delete/transfer/legal hold ke |
| **Commander** | Operations: staff, devices approve, duty plan, alerts, incidents, reports (apne units mein) |
| **Supervisor** | Apne unit ki duty plan, attendance review, alerts, incidents, live map |
| **Dispatcher** | Control room: live map, alerts, incidents/SOS handle karna |
| **Field Staff Member** | Sirf apni duty: start/end, break, QR scan, SOS, incident report, apna data dekhna. **Admin pages nahi dikhte.** |
| **Auditor / Reviewer** | Sirf **dekhna**: reports, audit log, attendance (koi badlav nahi) |

> Poori table: `docs/ROLE_PERMISSION_MATRIX.md`

---

## 4. Shuru kaise karein

### 4.1 Server chalana
VS Code terminal mein (project folder):
```
node --env-file=.env --import tsx apps/api/src/main.ts
```
"**listening**" aaye to server tayyar hai. Band karna ho to **Ctrl + C**.

> Agar MongoDB Atlas se connection error aaye (SSL / ServerSelection): Atlas → **Network Access** → apna IP add karein.

### 4.2 Website kholna
Browser: **http://localhost:8080** → **Ctrl + F5** (naya version load karne ke liye)

Pehla page **Platform sign-in** hai (Email + Password).

### 4.3 Super Admin login
- **`.env` wala account:** Email `admin@smartforce360.com`, Password: `.env` ka `PLATFORM_ADMIN_PASSWORD` (quotes ke **baghair**).
- **Ya naya account:** neeche **Create account** → Email, Password (12+ characters), Confirm password → **Create account** → phir **Sign in**. Simple mode mein har naya account **khud Super Admin** hota hai.
- 👁 aankh ke icon se password dekh sakte hain.

### 4.4 Demo data (testing ke liye bohot faida mand)
Demo company `demo`, fictional staff, posts, duties, alerts aur SOS ke saath:
```
node --env-file=.env --import tsx scripts/seed-demo.ts
```
(Ek hi dafa; dobara chalayein to "already exists" aayega.)

**Demo users** (sab ka password: `Demo-Passphrase-2026!`), Organisation ID: `demo`:

| Username | Role |
|---|---|
| `owner` | Organisation Owner |
| `cmd-01` | Commander |
| `sup-01`, `sup-02` | Supervisor |
| `dsp-01` | Dispatcher |
| `aud-01` | Auditor |
| `fo-001` … `fo-014` | Field Staff Member |

**Organization login:** login page → **Organisation sign-in** → Organisation ID `demo`, Username, Password → **Sign in**.

---

## 5. Platform (Super Admin)

Login ke baad **Platform console** khulta hai.

### 5.1 Health cards (upar)
**Kya hai:** Database (mongo), Job queue (due/dead), Live connections, Backup status.
**Test:** console kholein; Database card **green** aur "mongo" likha ho. Job queue "dead" 0 ho.

### 5.2 Provision organisation (nayi company banana)
**Kya hai:** nayi company + us ka Owner account.
**Test:**
1. **Provision organisation** dabayein.
2. Name: `Test Security`, ID (slug): `testsec`, Timezone: `Asia/Karachi`, Language, Plan, Owner username: `owner`, Owner name.
3. Save → ek **activation code** dikhega (sirf ek dafa); copy kar lein.
4. ✅ Table mein `testsec` "active" dikhe.
5. ❌ Dobara same ID se banayein → error aana chahiye (duplicate).

### 5.3 Organization ko suspend / resume / archive
**Test:**
1. Table mein company ke saamne **Suspend** → reason likhein → Confirm.
2. ✅ Status "suspended". Us company ka supervisor login karke dashboard khole → "organisation not active" type error.
3. ✅ Owner phir bhi login kar sakta hai (export ke liye).
4. **Resume** → ✅ sab normal.
5. ❌ Active company ko Resume → "invalid transition".

### 5.4 Plan dena
**Test:** company ke saamne **Plan** → plan chunein + reason → ✅ plan badal jaye. Chhoti limit (jaise 2 staff) par 3rd staff banane par **"PLAN_LIMIT_REACHED"** aaye, lekin **SOS phir bhi chale**.

### 5.5 Support access maangna
**Kya hai:** company ka andar ka data dekhne ke liye Owner se ijazat.
**Test:**
1. Company ke saamne **Request access** → reason (10+ characters), hours.
2. Owner login → **Organisation account** → support request → **Approve**.
3. ✅ Super Admin ab us company ke alerts/incidents/dashboard **sirf dekh** sakta hai, kuch badal nahi sakta.
4. ✅ Waqt khatam hone par access khud band.

### 5.6 Sign out
✅ **Sign out** → wapas Platform sign-in page.

---

## 6. Organization ke features (har page)

Organization login ke baad **left menu** mein do hisse hain: **Operations** aur **Administration**. Har banda sirf woh pages dekhta hai jin ki us ke role ko ijazat hai.

### 6.1 Pehli dafa: account activate karna
1. Login page → **Organisation sign-in** → **I have an activation code**.
2. Organisation ID, activation code, naya password (12+ characters).
3. ✅ "Activated" + username dikhe → ab login karein.
4. ❌ Ghalat code → error. ❌ Wahi code dobara → error (sirf ek dafa chalta hai).

### 6.2 Forgot password
**Forgot password?** → Organisation ID + username/email → link email par jata hai (**SMTP set hona chahiye**; abhi `.env` mein SMTP_HOST khaali hai, is liye email nahi jayegi).

### 6.3 Overview (dashboard)
**Kya hai:** aaj ke counters: on duty, late, SOS, alerts, coverage. Pehli dafa setup ki "go-live" checklist bhi.
**Test:** Owner/Supervisor login → ✅ numbers dikhen; demo data par on-duty staff aur SOS nazar aayen. Field user ko yeh page **nahi** dikhna chahiye.

### 6.4 Command centre (live map)
**Kya hai:** duty par staff ki live location, list + map. Har bande ka state (on duty, break, SOS, exception) aur **freshness** (live / recent / stale).
**Test:**
1. **Command centre** kholein → ✅ list mein log, map par nishan.
2. ✅ Purani location wala banda **"stale"** (khokhla/dashed nishan) dikhe, "live" nahi.
3. Kisi par click → detail panel (battery, accuracy, waqt).
4. **History:** waqt chunein + **purpose** (wajah) likhein → ✅ points dikhen. ❌ Purpose ke baghair → error.
> Map ke peeche sadkon wala naqsha tab aayega jab **Settings** mein tile server URL dalega; warna saada grid.

### 6.5 Alerts
**Kya hai:** system ke banaye alerts: late start, missed check-out, missed checkpoint, geofence exception, stale location, device offline, low battery, SOS.
**Test:**
1. **Alerts** kholein → demo mein late start aur SOS dikhen.
2. Alert chunein → **Acknowledge** → ✅ status "acknowledged".
3. **Snooze** (waqt) → ✅ "snoozed". **Resolve** (note) → ✅ "resolved".
4. Filter (type/status) laga kar dekhein.

### 6.6 Incidents & SOS
**Kya hai:** waqiat ka record; SOS khud incident banata hai.
**Test:**
1. Upar SOS banner aaye (demo) → click → incident khule.
2. **New incident** → type, severity, details → ✅ list mein aaye.
3. Incident kholein → status badlein (dispatched → on scene → closed), **responders** add karein, **note** likhein → ✅ timeline mein sab dikhe.
4. ❌ Closed incident ko ghalat state par le jaana → error.

### 6.7 Duty planner
**Kya hai:** shifts aur assignments (kaun kis post par kab).
**Test:**
1. Pehle **Posts & checkpoints** mein ek post honi chahiye (6.11).
2. **Duty planner** → shift banayein (post, tareekh, start/end waqt, recurrence ho to).
3. Staff assign karein → ✅ list mein "scheduled".
4. **Publish** roster → ✅ staff ko duty nazar aaye (version number badhe).
5. Assignment edit / **Cancel** → ✅ status badle.
6. ❌ Ek hi bande ko overlap wali do duties → overlap error/warning.

### 6.8 Attendance
**Kya hai:** duty start/end/break ka record, corrections (field banda ghalti theek karne ki darkhwast), review.
**Test:**
1. **Attendance** → events ki list (demo mein duty starts).
2. Correction request ho (field se) → **Approve** ya **Return** → ✅ status badle.
3. Assignment **review** (approve/return) → ✅ "reviewed".

### 6.9 Staff
**Kya hai:** staff banana, roles dena, invite, suspend/reinstate/offboard, data export/delete.
**Test:**
1. **Staff** → **New** → employee code, naam, unit, role → Save → ✅ list mein "invited".
2. Staff chunein → **Invitation** (code) → ✅ activation code dikhe → us se 6.1 wala activation karke login karein.
3. Role/unit badlein → ✅ save ho.
4. **Suspend** (reason) → ✅ woh login nahi kar sakta, sessions band. **Reinstate** → ✅ wapas.
5. **Offboard** → ✅ access hamesha ke liye khatam, devices revoke.
6. **Data export** → ✅ us bande ki file bane. **Data deletion** → (Owner) privacy request.
7. ❌ Duplicate employee code → error.
8. **CSV import** (ho to): dry run pehle, phir import.

### 6.10 Devices
**Kya hai:** field staff ke phones. Doosra phone **approval** maangta hai.
**Test:**
1. **Devices** → list (demo phones).
2. Simulator ka doosra phone (section 7) → ✅ "pending approval" → **Approve** → ✅ "active" (purana phone policy ke mutabiq revoke).
3. **Revoke** → ✅ woh phone kuch nahi bhej sakta.

### 6.11 Organisation (units aur teams)
**Kya hai:** company ka dhaancha: Region → Branch → Unit (tree), aur teams.
**Test:** **New unit** (parent chunein) → ✅ tree mein aaye. **Move** → ✅ jagah badle. ❌ Unit ko apne hi neeche move → error (cycle). **Team** banayein.

### 6.12 Posts & checkpoints
**Kya hai:** **Post** = duty ki jagah (lat/lon). **Geofence** = jagah ki hadd (circle/polygon). **Checkpoint** = patrol QR code.
**Test:**
1. **New post** → naam, unit, location (lat/lon) → ✅.
2. **Geofence** → circle (center + radius) → ✅. ❌ Ghalat polygon → error.
3. **Checkpoint** → ✅ QR banaye. **Reissue** → ✅ naya QR, purana bekaar.

### 6.13 Reports
**11 reports:** Attendance, Late starts, Absences, Missed checkpoints, Geofence exceptions, Location coverage, Incidents, SOS response time, Device and offline gaps, Attendance corrections, Audit extract.
**Test:**
1. **Reports** → report chunein → tareekh/unit filter → **Run**.
2. ✅ Har result par "**as of**" waqt, timezone aur basis likha ho.
3. **Export CSV** → ✅ job bane → kuch der mein **Download** → file kholein, data report jaisa ho.
4. Auditor login → reports chalen; Field user → reports **na** dikhen.

### 6.14 Audit log
**Kya hai:** har ahem kaam ka record (kis ne, kab, kya, pehle/baad), hash-chain se mehfooz.
**Test:** **Audit log** → filter (action, user) → ✅ aap ke kiye kaam (suspend, settings) nazar aayen. **Verify** → ✅ "integrity OK". Audit log padhna khud bhi record hota hai.

### 6.15 Settings
**Kya hai:** location freshness waqt (live/recent), alert rules, catalogues (incident types), labels (naam badalna), privacy notice, retention (purana data kab mitna hai), map tile URL.
**Test:**
1. Koi value badlein (jaise live seconds) → Save → ✅ version number badhe.
2. ❌ Hadd se bahar value → error.
3. **Alert rule** on/off ya waqt badlein → ✅ save.
4. **Privacy notice** naya version → ✅ field staff ko dobara accept karna padega.

### 6.16 Roles & access
**Kya hai:** roles ki permissions dekhna, custom role banana (clone karke), users unlock karna, MFA reset.
**Test:** custom role banayein → staff ko dein → ✅ us ke pages us hisaab se badlein. Locked user → **Unlock** → ✅.

### 6.17 Privacy & data
**Kya hai:** legal hold (data mitne se rokna), data subject requests.
**Test (Owner):** **Legal hold** banayein → ✅ retention us data ko nahi mitayegi. **Release** → ✅.

### 6.18 Organisation account
**Kya hai:** plan/subscription dekhna, poori company ka **export**, company delete request, support requests approve/deny/revoke.
**Test:** **Export** → ✅ file bane. Support request (5.5) → **Approve / Deny / Revoke** → ✅. Delete request banayein phir **cancel** karein.

### 6.19 Notifications
**Test:** bell/notifications → ✅ alerts aur requests ki in-app notifications. **Mark read**, **Read all** → ✅.

### 6.20 My data
**Kya hai:** har banda apna data dekh sakta hai: profile, duties, location access log (kis ne meri location dekhi).
**Test:** kisi bhi user se → ✅ apni hi maloomat dikhe.

### 6.21 Help & support
**Test:** ✅ support contact aur **diagnostics bundle** (bina secrets ke) download.

### 6.22 Zaban (Arabic)
**Test:** upar language → **العربية** → ✅ poori website right-to-left.

### 6.23 Mobile size
**Test:** browser chhota karein (ya phone par kholein) → ✅ menu aur pages istemal ke qabil.

---

## 7. Field staff (mobile)

**Mobile app abhi build nahi hui**, is liye field ka kaam **Field Simulator** se test hota hai. Woh bilkul mobile app wala engine use karta hai.

**Field banda kya karta hai (app mein):** sign in → privacy notice accept → aaj ki duty → **Start duty** (location ke saath) → GPS points bhejna → break → QR checkpoint scan → **SOS** → incident report → **End duty**. Internet na ho to sab **offline queue** mein jama hota hai aur baad mein bhej diya jata hai.

### Simulator chalana (demo data zaroori)
Server chalte hue, naye terminal mein:
```
node --env-file=.env --import tsx tools/field-simulator.ts --url http://localhost:8080 --tenant demo --users fo-002,fo-003 --minutes 3 --offline-every 3 --sos fo-002 --approver cmd-01
```
| Hissa | Matlab |
|---|---|
| `--users` | Kaun se field users (jin ki duty abhi **scheduled** ho) |
| `--minutes 3` | Kitni der chalana |
| `--offline-every 3` | Beech beech mein internet band/chalu (offline queue test) |
| `--sos fo-002` | Is bande se SOS bhejna |
| `--approver cmd-01` | Simulator ka phone "doosra device" hai; commander se approve karwana |

**Kya hona chahiye:**
- ✅ Terminal mein `device approved`, `start → accepted`, `online sent=…`, `OFFLINE … queued=…`, `SOS → …`, `ended duty, queue empty=true`.
- ✅ Website par (cmd-01 ya sup-01 se): **Command centre** mein woh banda live; SOS par **SOS banner**; **Incidents** mein naya SOS; **Alerts** mein SOS.
- Agar "duty was already started on another device" aaye: woh user demo mein pehle se duty par hai; doosra user chunein.

**Asli phone GPS** tab test hoga jab mobile app build ho kar phone par chalegi (abhi baqi hai).

---

## 8. Roles ki permission testing

Demo users se login karke check karein (password `Demo-Passphrase-2026!`):

Menu mein kaun se pages dikhte hain (permission matrix se nikala gaya). **Notifications, My data, Help** sab ko dikhte hain.

| Login | ✅ Menu mein dikhna chahiye | ❌ Nahi dikhna chahiye |
|---|---|---|
| `owner` (Owner) | Sab: Overview, Command centre, Alerts, Incidents & SOS, Duty planner, Attendance, Reports, Staff, Devices, Organisation, Posts & checkpoints, Roles & access, Settings, Privacy & data, Audit log, Organisation account | — |
| `cmd-01` (Commander) | Overview, Command centre, Alerts, Incidents & SOS, Duty planner, Attendance, Reports, Staff, Devices, Organisation, Posts & checkpoints, Organisation account | Roles & access, Settings, Privacy & data, Audit log |
| `sup-01` (Supervisor) | Commander jaise pages, lekin sirf **apne unit** ka data; staff/devices sirf dekh sakta hai | Roles & access, Settings, Privacy & data, Audit log |
| `dsp-01` (Dispatcher) | Overview, Command centre, Alerts, Incidents & SOS, Duty planner (dekhna), Organisation, Posts & checkpoints, Organisation account | Attendance, Reports, Staff, Devices, Settings, Audit log |
| `aud-01` (Auditor) | Alerts, Incidents & SOS, Duty planner, Attendance, Reports, Staff, Devices, Organisation, Posts & checkpoints, Roles & access, Settings, Audit log: **sab sirf dekhne ke liye** | Overview, Command centre (live location); koi bhi edit/save button kaam na kare |
| `fo-001` (Field) | Incidents & SOS (sirf report karna), Organisation account (dekhna), Notifications, My data, Help | Overview, Command centre, Alerts, Planner, Staff, Reports, Settings: sab admin pages |

Aur:
- ❌ Ek company ka user doosri company ka data kabhi na dekhe.
- ❌ Company user **Platform console** na khol sake.
- ❌ Super Admin company ka staff/location bina support approval na dekhe.

---

## 9. End-to-end test kahani

Yeh ek hi kahani poora system test kar deti hai:

1. **Super Admin** login → **Provision organisation** (`testsec`) → activation code copy.
2. **Owner** activate → login → **Settings** check → **Posts & checkpoints** mein post + geofence + checkpoint.
3. **Organisation** mein unit; **Staff** mein ek supervisor aur ek field banda → invitation codes.
4. Supervisor activate → login → **Duty planner** mein field bande ki shift → **Publish**.
5. Field kaam: **Simulator** `--tenant testsec --users <field username>` (field banda pehle activate ho; us ka pehla phone simulator hi hoga).
6. Supervisor: **Command centre** mein live location; simulator SOS → **SOS banner** → incident **dispatch → close**.
7. **Alerts** acknowledge/resolve. **Attendance** review.
8. **Reports** → Attendance + SOS response → **Export CSV** → download.
9. **Audit log** → saare kaam nazar aayen → **Verify**.
10. Super Admin → company **Suspend** → supervisor blocked → **Resume** → wapas normal.

---

## 10. Automated tests

Project folder mein (server ki zaroorat nahi; yeh apna alag test database banate hain):

| Command | Kya check karta hai |
|---|---|
| `npm test` | 66 tests: login, 2FA policy, roles, company isolation, saare 206 API routes, journeys |
| `npm run verify` | Upar wala + typecheck + lint + website build + API docs |
| `npm run test:e2e:web` | Asli Chrome mein 15 steps (build pehle: `npm run build:web`) |
| `npx tsx tests/e2e-web/platform-auth.ts` | Platform login page: validation, aankh icon, create account, login, logout (11 steps) |
| `npm run load` | Raftaar (1000 staff par live map/dashboard ka waqt) |

Chrome path set karna padta hai:
```
$env:CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"; npm run test:e2e:web
```

---

## 11. Aam masle aur hal

| Masla | Wajah | Hal |
|---|---|---|
| "The email or password is incorrect" | Ghalat email/password | `.env` wala password **bina quotes** ke; ya Create account se naya bana lein |
| `.env` ka password nahi chal raha | Server restart nahi kiya | Ctrl + C → server dobara chalayein |
| "This account is temporarily locked" | Ghalat password bohot dafa | Simple mode mein ab lock nahi lagta (naye restart ke baad); warna 15 min |
| Code / 2FA maang raha hai | Server production mode mein | `.env` mein `NODE_ENV=development`, `AUTH_MFA_REQUIRED=false`, restart |
| "Cannot reach the server" | Server band | Server chalayein (4.1) |
| Server start par MongoDB / SSL error | Atlas aap ka IP nahi pehchanta | Atlas → Network Access → IP add |
| Purana page dikh raha hai | Browser cache | **Ctrl + F5** |
| Organization login: "incorrect" | Organisation ID ghalat ya company bani nahi | Super Admin console mein company check; demo ke liye seed (4.4) |
| Email nahi aa rahi | SMTP set nahi | `.env` mein `SMTP_HOST` (deploy ke waqt) |
| Map par sirf grid | Tile server set nahi | Settings → map tile URL |

---

## 12. Deploy se pehle

Abhi **simple mode** hai (sirf local testing ke liye). Deploy se pehle **zaroor**:

1. `.env` mein `NODE_ENV=production` aur `AUTH_MFA_REQUIRED=true` (backup: `.env.bak-20261113-simple`).
2. Is se khud ba khud: **2FA lazmi**, **Create account sirf invitation code se**, **account lock** wapas on.
3. `PUBLIC_URL` https wala domain, `CORS_ORIGINS` sahi.
4. SMTP (email) set karein; map tile provider set karein.
5. Mobile app build karke asli phone par GPS test karein.
6. MongoDB Atlas Network Access mein server ka IP.
7. Mazeed tafseel: `PRODUCTION_DEPENDENCIES.md` aur `PRODUCTION_READINESS_AUDIT.md`.

---

## 13. Testing checklist

Har item test karke `[x]` laga dein.

**Platform**
- [ ] Super Admin login (`.env` account)
- [ ] Create account → naya Super Admin → login
- [ ] Ghalat password → error · khali form → field ke saath messages · aankh icon
- [ ] Provision organisation → activation code
- [ ] Suspend → staff blocked → Resume
- [ ] Plan badalna → limit
- [ ] Support access request → Owner approve → read-only access
- [ ] Health cards · Sign out

**Organization**
- [ ] Owner activate + login
- [ ] Overview numbers
- [ ] Unit · Team
- [ ] Post · Geofence · Checkpoint (QR, reissue)
- [ ] Staff new → invitation → activate → login
- [ ] Staff suspend / reinstate / offboard
- [ ] Duty planner: shift → assign → publish → cancel
- [ ] Devices: approve / revoke
- [ ] Command centre: live, stale, history (purpose ke saath)
- [ ] Alerts: acknowledge / snooze / resolve
- [ ] Incidents: new → dispatch → close, responders, notes
- [ ] SOS banner
- [ ] Attendance: correction approve/return, review
- [ ] Reports: run + CSV export download (11 reports)
- [ ] Audit log + Verify
- [ ] Settings save + version · alert rules · privacy notice
- [ ] Roles: custom role · unlock
- [ ] Privacy: legal hold
- [ ] Organisation account: export · support approve/deny
- [ ] Notifications · My data · Help
- [ ] Arabic (RTL) · mobile size

**Field (simulator)**
- [ ] Device approval · duty start · GPS points · offline → online
- [ ] SOS (offline se bhi) → website par banner + incident
- [ ] Duty end · queue khaali

**Permissions**
- [ ] Har demo role (section 8) sirf apne pages dekhe
- [ ] Ek company doosri ka data na dekhe
- [ ] Company user Platform console na khol sake

**Automated**
- [ ] `npm run verify` green
- [ ] `npm run test:e2e:web` 15/15
- [ ] `platform-auth.ts` 11/11
