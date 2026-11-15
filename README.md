# AttendEase — Smart College Attendance Management System

A working, end-to-end web application for marking and managing **student** and **staff** attendance
across seven engineering departments, with SMS notifications to guardians, correction approvals,
audit trails and CSV/Excel/PDF reporting.

Built to be usable by teachers on a phone in under a minute: pick class → tap statuses →
review → submit.

---

## 1. What actually works (verified by automated tests)

Run `npm --prefix server test` — 31 API tests execute against a real PostgreSQL engine with real
HTTP requests. Current result: **31/31 passing**. Highlights:

| Area | Verified behaviour |
|---|---|
| Auth | Login, httpOnly + SameSite session cookie, logout revokes session, identical error for wrong password vs unknown user (no account enumeration) |
| RBAC | Teacher of another department → `403`; student/staff/teacher cannot mark staff attendance → `403`; teacher cannot create users → `403`; student sees only their own department |
| Student attendance | Teacher submits → rows persisted in PostgreSQL; summary counts returned |
| Duplicate prevention | Second submit for same class+subject+date+period → `409` with `requires_confirmation`; DB unique index also blocks a direct INSERT (`duplicate key value`) |
| Integrity | Cross-class student injection → `400`; locked session edit → `409` |
| Staff attendance | HOD marks the whole department; another department's teacher → `403` |
| Corrections | Teacher raises correction (record unchanged) → HOD approves → record updated → `correction.approved` written to `audit_logs`; re-deciding → `409`; teacher cannot approve → `403` |
| SMS | Absence enqueues one message per guardian; attendance rows remain intact; re-enqueue creates **no** duplicates (idempotency key); with no credentials every row is `not_sent` (never `sent`); invalid phone → `not_sent` |
| Reports | CSV (`text/csv`, header row), XLSX (`PK` zip signature), PDF (`%PDF` signature); report totals match seeded/created data; student export → `403` |
| Dashboard | Admin sees all departments; HOD sees only their own; audit log restricted |

## 2. What needs credentials / configuration (not faked)

| Item | Status | What you must do |
|---|---|---|
| **Real SMS delivery** | Code path implemented (`server/src/services/sms.ts`, MSG91 flow API over HTTPS, server-side only). **Default driver is `log`, which records `not_sent`.** Nothing ever reports a delivery that did not happen. | Set `SMS_DRIVER=msg91`, `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_FLOW_ID` + an **approved DLT template**; point the provider's DLR webhook at `POST /api/sms/dlr?key=$SMS_DLR_SECRET`. Then use *SMS → Send a test SMS* and confirm the status changes to `sent`/`delivered`. |
| **Hosting / HTTPS** | Runs locally on `http://localhost:4000`. | Deploy behind HTTPS, set `COOKIE_SECURE=1`, `NODE_ENV=production`, `TRUST_PROXY=1`. |
| **Managed PostgreSQL** | Default database is **PGlite** = the real PostgreSQL engine compiled to WASM, on disk (the sandbox had no root to install a Postgres service). Schema/constraints are plain PostgreSQL. | Production: create a PostgreSQL/Supabase database and set `DB_DRIVER=postgres` + `DATABASE_URL` (a thin driver swap in `server/src/db/index.ts`). |
| **Database backups** | Not automated. | Use your provider's PITR/`pg_dump` schedule. |
| **MFA for admins** | Not implemented (password reset + deactivation are). | Optional next step; sessions are already revocable per user. |
| **Email notifications** | Not implemented (in-app notifications endpoint exists). | Add an SMTP provider if required. |
| **Demo vs production data** | Demo rows carry `is_demo = TRUE` on `students`, `staff` and `attendance_sessions`. | Filter or delete demo rows before go-live (see §7). |

## 3. Architecture

```
attendease/
├── server/                 Express + TypeScript REST API (also serves the built SPA)
│   ├── src/config.ts       All env-driven config; secrets never reach the browser
│   ├── src/db/             PGlite/PostgreSQL pool, migrations, 15-table schema
│   ├── src/middleware/     Session auth, RBAC, department/assignment scoping
│   ├── src/routes/         auth · catalog (depts/classes/subjects/assignments) · people
│   │                       attendance · dashboard · reports · smsAdmin
│   ├── src/services/       sms.ts (MSG91 adapter + outbox worker) · smsQueue.ts (policy→messages)
│   ├── src/tests/          supertest API suite (31 tests)
│   └── public/             Built frontend (created by `npm run build`)
└── web/                    React 18 + TypeScript + Vite + Tailwind + Recharts + PWA
```

**Roles:** `admin`, `hod`, `teacher`, `student`, `staff` — enforced on the server for every mutation.

**Database (15 tables):** `departments`, `users`, `role_permissions`, `classes`, `subjects`, `periods`,
`students`, `staff`, `teacher_assignments`, `attendance_sessions`, `student_attendance`,
`staff_attendance`, `parent_contacts`, `sms_templates`, `sms_policies`, `sms_outbox`,
`notifications`, `attendance_corrections`, `audit_logs`, `auth_sessions`.

Key constraints:
```sql
CREATE UNIQUE INDEX uq_session_student
  ON attendance_sessions (class_id, subject_id, session_date, period_no) WHERE kind = 'student';
CREATE UNIQUE INDEX uq_session_staff
  ON attendance_sessions (department_id, session_date, period_no) WHERE kind = 'staff';
UNIQUE (session_id, student_id)          -- one status per student per session
sms_outbox.idempotency_key UNIQUE        -- no duplicate SMS on retry
```

## 4. Quick start

```bash
cd attendease
npm run install:all          # install server + web dependencies
cp .env.example .env         # then edit if you want real SMS
npm run build                # compile API + build the SPA into server/public
npm run seed                 # migrate + create 7 departments + demo data
npm start                    # http://localhost:4000
```

Development with hot reload:

```bash
npm run dev                  # API on :4000 (tsx watch) + Vite on :5173 (proxying /api)
```

Tests:

```bash
npm --prefix server test     # tsc + node --test (31 API tests)
```

## 5. Demo logins (seeded)

| Role | Email | Password |
|---|---|---|
| Administrator | `admin@attendease.college` | `Admin@123` |
| HOD — Computer Science | `hod.cs@attendease.college` | `Hod@123` |
| Teacher — Computer Science | `teacher.cs@attendease.college` | `Teacher@123` |
| Student | `student@attendease.college` | `Student@123` |
| Staff (non-teaching) | `staff.cs@attendease.college` | `Staff@123` |

Each department also has `hod.<code>@attendease.college` and `teacher.<code>@attendease.college`
(`aiml`, `aids`, `cyber`, `ece`, `cs`, `mech`, `civil`). **Change every password before production.**

## 6. Main flows

**Student attendance:** Department → Class/Section → Subject → Period → Date → roster loads
(everyone pre-marked Present) → tap P / A / L per student → search, A–Z sort, *Mark found absent*,
*Select all present*, **Undo** (last 60 taps) → *Review & submit* confirmation showing counts →
saved with teacher id, timestamp, subject, period; SMS enqueued per department policy.

**Staff attendance:** HOD/Admin picks department + date + session → teaching and non-teaching
listed separately → P / A / L / Half-Day → *All present* per group → submit. Staff cannot edit
their own records (only view).

**Corrections:** submitted attendance is immutable. A teacher raises a correction with a reason;
the HOD/admin approves or rejects. Approval updates the record and writes `before_data`/`after_data`
to `audit_logs`. Locked sessions must be unlocked first.

**SMS:** policy rows (department → audience → trigger → recipient) decide who gets notified.
Messages are queued *after* the attendance transaction commits, so a gateway outage can never lose
attendance. The worker retries with exponential backoff (30 s → 30 min) up to `SMS_MAX_ATTEMPTS`
using `FOR UPDATE SKIP LOCKED` + a unique idempotency key.

**Reports:** daily register, student-wise, subject-wise %, department-wise student/staff, monthly
staff, absent list, low-attendance (< threshold), SMS delivery, correction history — each exportable
to CSV, XLSX and PDF with the same filters.

## 7. Security notes

- Passwords: scrypt (N=16384, r=8, p=1) with per-password salt; constant-time comparison.
- Sessions: 32-byte random token, stored only as SHA-256 hash, httpOnly + SameSite=Lax cookie,
  revocable server-side; deactivating a user revokes all their sessions.
- RBAC is enforced in middleware on every route; the UI only hides what the API already refuses.
- Phone numbers are masked in bulk SMS listings; students can only ever read their own records.
- Gateway keys live in environment variables and are used only from server code.
- Every attendance write, correction, lock and config change is appended to `audit_logs`.

## 8. Removing demo data before go-live

```sql
DELETE FROM attendance_sessions WHERE is_demo = TRUE;   -- cascades to attendance rows
DELETE FROM students WHERE is_demo = TRUE;
DELETE FROM staff WHERE is_demo = TRUE;
-- then create real departments/classes/students via Administration
```

## 9. Free deployment (Supabase + Render)

The included `render.yaml` deploys the React app and Express API together as one Render web
service, and uses Supabase for PostgreSQL. No ngrok tunnel is needed. The frontend is already
React and is built into `server/public` so the app and API share one origin.

1. Create a Supabase Free project and copy its PostgreSQL connection string. Use the Supavisor
   session pooler connection string if the direct database host is unreachable from Render.
2. In Render, create a Blueprint from this repository and provide that connection string as
   `DATABASE_URL` when prompted. Keep `DB_DRIVER=postgres`; Render runs migrations on startup and
   seeds demo accounts once after the first successful deploy.
3. The demo administrator is `admin@attendease.college` / `Admin@123`. Change demo passwords before
   sharing the deployed app with real users.

Both services have free tiers. Render's free web service sleeps after 15 minutes without traffic
and may take about a minute to wake. Supabase Free includes 500 MB of database storage and may
pause a project after a week of low activity; it does not include automatic database backups.
This setup is for demos and small experiments, not the only copy of real attendance records.

## 10. PWA

`web/public/manifest.webmanifest` + `web/public/sw.js` make the app installable on Android/iOS.
The service worker caches only the app shell — `/api/*` is never cached, so attendance is always
fresh.
