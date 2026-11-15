import { getDb, q } from './index.js';
import { SCHEMA_V1 } from './schema.js';

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: 'initial_schema', sql: SCHEMA_V1 },
  { version: 2, name: 'class_cycles', sql: "ALTER TABLE classes ADD COLUMN IF NOT EXISTS cycle TEXT NOT NULL DEFAULT 'standard' CHECK (cycle IN ('standard','chemistry','physics'));" },
];

export async function migrate(): Promise<{ applied: number[] }> {
  const db = await getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);
  const done = await q<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(done.map((r) => Number(r.version)));
  const newlyApplied: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.exec('BEGIN');
    try {
      await db.exec(m.sql);
      await q('INSERT INTO schema_migrations (version, name) VALUES ($1,$2)', [m.version, m.name]);
      await db.exec('COMMIT');
      newlyApplied.push(m.version);
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  }
  return { applied: newlyApplied };
}

/** Idempotent reference data (periods, roles/permissions, SMS templates & default policy). */
export async function seedReferenceData(): Promise<void> {
  const periods = [
    [1, 'Period 1', '09:00', '09:50'],
    [2, 'Period 2', '09:50', '10:40'],
    [3, 'Period 3', '10:55', '11:45'],
    [4, 'Period 4', '11:45', '12:35'],
    [5, 'Period 5', '13:30', '14:20'],
    [6, 'Period 6', '14:20', '15:10'],
    [7, 'Period 7', '15:20', '16:10'],
    [8, 'Period 8', '16:10', '17:00'],
  ];
  for (const [no, label, start, end] of periods) {
    await q(
      `INSERT INTO periods (period_no, label, start_time, end_time) VALUES ($1::int,$2::text,$3::text,$4::text)
       ON CONFLICT (period_no) DO UPDATE SET label=EXCLUDED.label, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time`,
      [no, label, start, end],
    );
  }

  const perms: [string, string][] = [
    ['admin', 'departments.manage'],
    ['admin', 'users.manage'],
    ['admin', 'students.manage'],
    ['admin', 'staff.manage'],
    ['admin', 'attendance.view.all'],
    ['admin', 'attendance.mark.any'],
    ['admin', 'reports.view.all'],
    ['admin', 'sms.configure'],
    ['admin', 'audit.view'],
    ['admin', 'corrections.decide'],
    ['hod', 'attendance.view.department'],
    ['hod', 'attendance.mark.department'],
    ['hod', 'reports.view.department'],
    ['hod', 'corrections.decide'],
    ['hod', 'students.view.department'],
    ['teacher', 'attendance.mark.assigned'],
    ['teacher', 'attendance.view.assigned'],
    ['teacher', 'attendance.mark.self'],
    ['teacher', 'corrections.request'],
    ['teacher', 'reports.view.assigned'],
    ['student', 'attendance.view.self'],
    ['student', 'notifications.view.self'],
    ['staff', 'attendance.view.self'],
    ['staff', 'notifications.view.self'],
  ];
  for (const [role, permission] of perms) {
    await q('INSERT INTO role_permissions (role, permission) VALUES ($1::text,$2::text) ON CONFLICT DO NOTHING', [role, permission]);
  }

  const templates: [string, string, string][] = [
    [
      'student_attendance',
      'student',
      'Dear Parent, your ward {{student_name}} ({{roll_no}}) was marked {{status}} for {{subject}} on {{date}} at {{college_name}}. Please contact the college for any clarification.',
    ],
    [
      'staff_attendance',
      'staff',
      'Dear {{staff_name}}, your attendance for {{date}} has been recorded as {{status}} at {{college_name}}.',
    ],
  ];
  for (const [code, audience, body] of templates) {
    await q(
      `INSERT INTO sms_templates (code, audience, body) VALUES ($1::text,$2::text,$3::text) ON CONFLICT (code) DO NOTHING`,
      [code, audience, body],
    );
  }

  // Default policy: notify guardians on absence only (privacy-friendly default), staff on absence.
  const defaults: [string, string, string][] = [
    ['student', 'absent', 'guardian'],
    ['staff', 'absent', 'self'],
  ];
  for (const [audience, notifyOn, recipient] of defaults) {
    await q(
      `INSERT INTO sms_policies (department_id, audience, notify_on, recipient, enabled)
       VALUES (NULL,$1::text,$2::text,$3::text,TRUE) ON CONFLICT DO NOTHING`,
      [audience, notifyOn, recipient],
    );
  }
}
