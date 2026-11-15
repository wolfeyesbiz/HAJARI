/**
 * Relational schema for AttendEase (PostgreSQL dialect).
 * Applied by migrate.ts inside a version-tracked migration.
 */
export const SCHEMA_V1 = /* sql */ `
CREATE TABLE IF NOT EXISTS departments (
  id            SERIAL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  phone          TEXT,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin','hod','teacher','student','staff')),
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role        TEXT NOT NULL,
  permission  TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE TABLE IF NOT EXISTS classes (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  department_id  INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  semester       INTEGER NOT NULL CHECK (semester BETWEEN 1 AND 8),
  section        TEXT NOT NULL DEFAULT 'A',
  academic_year  TEXT NOT NULL DEFAULT '2026-27',
  cycle          TEXT NOT NULL DEFAULT 'standard' CHECK (cycle IN ('standard','chemistry','physics')),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (name, department_id, semester, section, academic_year)
);

CREATE TABLE IF NOT EXISTS subjects (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  department_id  INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  semester       INTEGER NOT NULL,
  credits        INTEGER NOT NULL DEFAULT 4,
  active         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS periods (
  period_no   INTEGER PRIMARY KEY,
  label       TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id              SERIAL PRIMARY KEY,
  roll_no         TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  department_id   INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  class_id        INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  semester        INTEGER NOT NULL,
  section         TEXT NOT NULL DEFAULT 'A',
  guardian_name   TEXT,
  guardian_phone  TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  is_demo         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_students_dept ON students(department_id);

CREATE TABLE IF NOT EXISTS staff (
  id                 SERIAL PRIMARY KEY,
  staff_code         TEXT NOT NULL UNIQUE,
  full_name          TEXT NOT NULL,
  designation        TEXT NOT NULL,
  department_id      INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  phone              TEXT,
  email              TEXT,
  employment_type    TEXT NOT NULL DEFAULT 'teaching' CHECK (employment_type IN ('teaching','non_teaching')),
  employment_status  TEXT NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','inactive')),
  is_demo            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_dept ON staff(department_id);

CREATE TABLE IF NOT EXISTS teacher_assignments (
  id               SERIAL PRIMARY KEY,
  teacher_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id    INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  class_id         INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id       INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (teacher_user_id, class_id, subject_id)
);

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id                SERIAL PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('student','staff')),
  department_id     INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  class_id          INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  subject_id        INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
  period_no         INTEGER,
  session_date      DATE NOT NULL,
  taken_by_user_id  INTEGER NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','locked')),
  marked_staff_id   INTEGER REFERENCES staff(id),
  notes             TEXT,
  is_demo           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at      TIMESTAMPTZ,
  locked_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Duplicate prevention is enforced by the database, not only by the UI.
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_student
  ON attendance_sessions (class_id, subject_id, session_date, period_no) WHERE kind = 'student';
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_staff
  ON attendance_sessions (department_id, session_date, period_no) WHERE kind = 'staff';
CREATE INDEX IF NOT EXISTS idx_sessions_date ON attendance_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_sessions_dept ON attendance_sessions(department_id);

CREATE TABLE IF NOT EXISTS student_attendance (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('present','absent','leave')),
  remark       TEXT,
  marked_by    INTEGER REFERENCES users(id),
  marked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_sa_student ON student_attendance(student_id);

CREATE TABLE IF NOT EXISTS staff_attendance (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('present','absent','leave','half_day')),
  remark       TEXT,
  marked_by    INTEGER REFERENCES users(id),
  marked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_staffatt_staff ON staff_attendance(staff_id);

CREATE TABLE IF NOT EXISTS parent_contacts (
  id             SERIAL PRIMARY KEY,
  student_id     INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  relation       TEXT NOT NULL DEFAULT 'Parent',
  phone          TEXT NOT NULL,
  consent_given  BOOLEAN NOT NULL DEFAULT TRUE,
  is_primary     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_parent_student ON parent_contacts(student_id);

CREATE TABLE IF NOT EXISTS sms_templates (
  code        TEXT PRIMARY KEY,
  audience    TEXT NOT NULL CHECK (audience IN ('student','staff')),
  body        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_policies (
  id             SERIAL PRIMARY KEY,
  department_id  INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  audience       TEXT NOT NULL CHECK (audience IN ('student','staff')),
  notify_on      TEXT NOT NULL CHECK (notify_on IN ('present','absent','leave')),
  recipient      TEXT NOT NULL DEFAULT 'guardian' CHECK (recipient IN ('guardian','self','both')),
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy
  ON sms_policies (COALESCE(department_id, 0), audience, notify_on);

CREATE TABLE IF NOT EXISTS sms_outbox (
  id                  SERIAL PRIMARY KEY,
  idempotency_key     TEXT NOT NULL UNIQUE,
  to_phone            TEXT NOT NULL,
  recipient_kind      TEXT NOT NULL,
  audience            TEXT NOT NULL,
  student_id          INTEGER REFERENCES students(id) ON DELETE SET NULL,
  staff_id            INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  department_id       INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  session_id          INTEGER REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  ref_type            TEXT NOT NULL,
  ref_id              INTEGER NOT NULL,
  status_value        TEXT NOT NULL,
  template_code       TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','delivered','failed','not_sent')),
  provider            TEXT,
  provider_message_id TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_dispatch ON sms_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON sms_outbox(created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id             SERIAL PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  record_type    TEXT NOT NULL CHECK (record_type IN ('student','staff')),
  student_id     INTEGER REFERENCES students(id) ON DELETE CASCADE,
  staff_id       INTEGER REFERENCES staff(id) ON DELETE CASCADE,
  old_status     TEXT,
  new_status     TEXT NOT NULL,
  reason         TEXT NOT NULL,
  requested_by   INTEGER NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_corr_status ON attendance_corrections(status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            SERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  entity        TEXT NOT NULL,
  entity_id     TEXT,
  before_data   JSONB,
  after_data    JSONB,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_authsess_user ON auth_sessions(user_id);
`;
