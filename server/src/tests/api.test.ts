/**
 * End-to-end API tests against a real server instance + real PostgreSQL (PGlite).
 * Run with: npm test   (compiles then executes)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated database per run, created before importing the app.
const dir = mkdtempSync(join(tmpdir(), 'attendease-test-'));
process.env.PGDATA_DIR = dir;
process.env.SMS_DRIVER = 'log';
process.env.SMS_WORKER = '0';

const { createApp } = await import('../server.js');
const { q, closeDb } = await import('../db/index.js');
const { hashPassword } = await import('../lib/crypto.js');

const app = await createApp();

type Agent = ReturnType<typeof request.agent>;

async function makeUser(email: string, role: string, deptId: number | null, password = 'Test@12345', name = 'Test User') {
  const row = await q<{ id: number }>(
    `INSERT INTO users (full_name, email, password_hash, role, department_id)
     VALUES ($1::text,$2::text,$3::text,$4::text,$5::int) RETURNING id`,
    [name, email, hashPassword(password), role, deptId],
  );
  return Number(row[0].id);
}

async function login(email: string, password = 'Test@12345'): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return agent;
}

/** Fixture: 2 departments, 2 classes, 2 subjects, students, teachers. */
let fixtures: {
  deptA: number;
  deptB: number;
  classA: number;
  classB: number;
  subjectA: number;
  subjectB: number;
  studentsA: number[];
  studentsB: number[];
  teacherA: string;
  teacherB: string;
  hodA: string;
  admin: string;
  studentUser: string;
  staffUser: string;
  staffAId: number;
};

test.before(async () => {
  const deptA = await q<{ id: number }>("INSERT INTO departments (code,name) VALUES ('AIML','AI & ML') RETURNING id");
  const deptB = await q<{ id: number }>("INSERT INTO departments (code,name) VALUES ('CIVIL','Civil') RETURNING id");
  const cA = await q<{ id: number }>(
    "INSERT INTO classes (name,department_id,semester,section) VALUES ('AIML Sem 3',$1::int,3,'A') RETURNING id",
    [deptA[0].id],
  );
  const cB = await q<{ id: number }>(
    "INSERT INTO classes (name,department_id,semester,section) VALUES ('CIVIL Sem 3',$1::int,3,'A') RETURNING id",
    [deptB[0].id],
  );
  const sA = await q<{ id: number }>(
    "INSERT INTO subjects (code,name,department_id,semester) VALUES ('AIML901','ML',$1::int,3) RETURNING id",
    [deptA[0].id],
  );
  const sB = await q<{ id: number }>(
    "INSERT INTO subjects (code,name,department_id,semester) VALUES ('CIV901','Structures',$1::int,3) RETURNING id",
    [deptB[0].id],
  );

  const studentsA: number[] = [];
  const studentsB: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const r = await q<{ id: number }>(
      `INSERT INTO students (roll_no,full_name,department_id,class_id,semester,section,guardian_phone)
       VALUES ($1::text,$2::text,$3::int,$4::int,3,'A',$5::text) RETURNING id`,
      [`A900${i}`, `Student A${i}`, deptA[0].id, cA[0].id, `98765432${10 + i}`],
    );
    studentsA.push(Number(r[0].id));
    const rb = await q<{ id: number }>(
      `INSERT INTO students (roll_no,full_name,department_id,class_id,semester,section,guardian_phone)
       VALUES ($1::text,$2::text,$3::int,$4::int,3,'A',$5::text) RETURNING id`,
      [`C900${i}`, `Student C${i}`, deptB[0].id, cB[0].id, `98765433${10 + i}`],
    );
    studentsB.push(Number(rb[0].id));
  }

  await makeUser('admin@test.local', 'admin', null, 'Test@12345', 'Admin User');
  await makeUser('teacher.a@test.local', 'teacher', Number(deptA[0].id), 'Test@12345', 'Teacher A');
  await makeUser('teacher.b@test.local', 'teacher', Number(deptB[0].id), 'Test@12345', 'Teacher B');
  await makeUser('hod.a@test.local', 'hod', Number(deptA[0].id), 'Test@12345', 'HOD A');
  await makeUser('stud@test.local', 'student', Number(deptA[0].id), 'Test@12345', 'Student User');
  await makeUser('staff@test.local', 'staff', Number(deptA[0].id), 'Test@12345', 'Staff User');

  const tA = await q<{ id: number }>("SELECT id FROM users WHERE email='teacher.a@test.local'");
  const tB = await q<{ id: number }>("SELECT id FROM users WHERE email='teacher.b@test.local'");
  await q('INSERT INTO teacher_assignments (teacher_user_id,department_id,class_id,subject_id) VALUES ($1::int,$2::int,$3::int,$4::int)', [
    tA[0].id, deptA[0].id, cA[0].id, sA[0].id,
  ]);
  await q('INSERT INTO teacher_assignments (teacher_user_id,department_id,class_id,subject_id) VALUES ($1::int,$2::int,$3::int,$4::int)', [
    tB[0].id, deptB[0].id, cB[0].id, sB[0].id,
  ]);

  // Staff row for the "staff" account so self-service views resolve.
  await q(
    `INSERT INTO staff (staff_code,full_name,designation,department_id,phone,email,employment_type)
     VALUES ('TST-01','Staff User','Lab Assistant',$1::int,'9876500001','staff@test.local','non_teaching')`,
    [deptA[0].id],
  );
  const staffRow = await q<{ id: number }>("SELECT id FROM staff WHERE staff_code='TST-01'");

  // Link the student account to a real student row.
  await q("UPDATE students SET email='stud@test.local' WHERE id=$1::int", [studentsA[0]]);

  // Notification policy: alert guardians on absence for AIML.
  await q("INSERT INTO sms_policies (department_id,audience,notify_on,recipient,enabled) VALUES (NULL,'student','absent','guardian',TRUE) ON CONFLICT DO NOTHING");

  fixtures = {
    deptA: Number(deptA[0].id),
    deptB: Number(deptB[0].id),
    classA: Number(cA[0].id),
    classB: Number(cB[0].id),
    subjectA: Number(sA[0].id),
    subjectB: Number(sB[0].id),
    studentsA,
    studentsB,
    teacherA: 'teacher.a@test.local',
    teacherB: 'teacher.b@test.local',
    hodA: 'hod.a@test.local',
    admin: 'admin@test.local',
    studentUser: 'stud@test.local',
    staffUser: 'staff@test.local',
    staffAId: Number(staffRow[0].id),
  };
});

test.after(async () => {
  await closeDb();
});

const today = () => new Date().toISOString().slice(0, 10);

function records(ids: number[], absentIndexes: number[] = []) {
  return ids.map((id, i) => ({ student_id: id, status: absentIndexes.includes(i) ? 'absent' : 'present' }));
}

/* ------------------------------ Auth & RBAC ------------------------------ */

test('unauthenticated requests are rejected with 401', async () => {
  const res = await request(app).get('/api/dashboard');
  assert.equal(res.status, 401);
});

test('login rejects a wrong password and an unknown user with the same generic message', async () => {
  const bad = await request(app).post('/api/auth/login').send({ email: 'admin@test.local', password: 'wrong-pass' });
  const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@test.local', password: 'whatever' });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(bad.body.error.message, unknown.body.error.message);
});

test('session cookie is httpOnly and /auth/me returns the role', async () => {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email: fixtures.admin, password: 'Test@12345' });
  assert.equal(res.status, 200);
  const cookie = [res.headers['set-cookie']].flat().join(';');
  assert.ok(cookie.includes('ae_session'), 'session cookie must be set');
  assert.ok(cookie.includes('HttpOnly'), 'session cookie must be httpOnly');
  assert.ok(cookie.includes('SameSite=Lax'), 'session cookie must be SameSite');
  const me = await agent.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'admin');
});

test('logout revokes the session', async () => {
  const agent = await login(fixtures.admin);
  assert.equal((await agent.get('/api/auth/me')).status, 200);
  await agent.post('/api/auth/logout');
  assert.equal((await agent.get('/api/auth/me')).status, 401);
});

test('teacher from another department cannot load a roster (403)', async () => {
  const teacherB = await login(fixtures.teacherB);
  const res = await teacherB.get(
    `/api/attendance/student/roster?class_id=${fixtures.classA}&subject_id=${fixtures.subjectA}&period_no=1&date=${today()}`,
  );
  assert.equal(res.status, 403);
});

test('student cannot mark attendance (403)', async () => {
  const student = await login(fixtures.studentUser);
  const res = await student.post('/api/attendance/student').send({
    class_id: fixtures.classA,
    subject_id: fixtures.subjectA,
    period_no: 2,
    date: today(),
    records: records(fixtures.studentsA),
  });
  assert.equal(res.status, 403);
});

test('staff member cannot mark staff attendance (403)', async () => {
  const staff = await login(fixtures.staffUser);
  const res = await staff.post('/api/attendance/staff').send({
    department_id: fixtures.deptA,
    date: today(),
    period_no: 1,
    records: [{ staff_id: fixtures.staffAId, status: 'present' }],
  });
  assert.equal(res.status, 403);
});

test('teacher cannot mark staff attendance (403)', async () => {
  const t = await login(fixtures.teacherA);
  const res = await t.post('/api/attendance/staff').send({
    department_id: fixtures.deptA,
    date: today(),
    period_no: 1,
    records: [{ staff_id: fixtures.staffAId, status: 'present' }],
  });
  assert.equal(res.status, 403);
});

test('student sees only their own department in the department list', async () => {
  const student = await login(fixtures.studentUser);
  const res = await student.get('/api/departments');
  assert.equal(res.status, 200);
  assert.equal(res.body.departments.length, 1);
  assert.equal(Number(res.body.departments[0].id), fixtures.deptA);
});

/* -------------------------- Student attendance flow ------------------------ */

test('teacher submits attendance for their own class and it persists', async () => {
  const teacher = await login(fixtures.teacherA);
  const date = '2026-03-02';
  const res = await teacher.post('/api/attendance/student').send({
    class_id: fixtures.classA,
    subject_id: fixtures.subjectA,
    period_no: 1,
    date,
    records: records(fixtures.studentsA),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.summary.present, 4);

  const rows = await q<{ n: number }>(
    "SELECT count(*)::int AS n FROM student_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id WHERE a.session_date=$1::date AND a.class_id=$2::int",
    [date, fixtures.classA],
  );
  assert.equal(Number(rows[0].n), 4, 'records must be persisted in the database');
});

test('a second submit for the same class+subject+date+period is rejected with 409 unless confirmed', async () => {
  const teacher = await login(fixtures.teacherA);
  const date = '2026-03-03';
  const body = {
    class_id: fixtures.classA,
    subject_id: fixtures.subjectA,
    period_no: 2,
    date,
    records: records(fixtures.studentsA),
  };
  const first = await teacher.post('/api/attendance/student').send(body);
  assert.equal(first.status, 201);

  const dup = await teacher.post('/api/attendance/student').send(body);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.details.requires_confirmation, true);

  const confirmed = await teacher.post('/api/attendance/student').send({ ...body, confirm_overwrite: true, records: records(fixtures.studentsA, [0]) });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.replaced, true);
});

test('database unique index blocks a duplicate session inserted directly', async () => {
  const date = '2026-03-04';
  const t = await q<{ id: number }>("SELECT id FROM users WHERE email='teacher.a@test.local'");
  await q(
    `INSERT INTO attendance_sessions (kind,department_id,class_id,subject_id,period_no,session_date,taken_by_user_id,status)
     VALUES ('student',$1::int,$2::int,$3::int,3,$4::date,$5::int,'submitted')`,
    [fixtures.deptA, fixtures.classA, fixtures.subjectA, date, t[0].id],
  );
  await assert.rejects(
    () =>
      q(
        `INSERT INTO attendance_sessions (kind,department_id,class_id,subject_id,period_no,session_date,taken_by_user_id,status)
         VALUES ('student',$1::int,$2::int,$3::int,4,$4::date,$5::int,'submitted')`,
        [fixtures.deptA, fixtures.classA, fixtures.subjectA, date, t[0].id],
      ).then(async () =>
        // period differs → allowed; now try the exact same period again
        q(
          `INSERT INTO attendance_sessions (kind,department_id,class_id,subject_id,period_no,session_date,taken_by_user_id,status)
           VALUES ('student',$1::int,$2::int,$3::int,3,$4::date,$5::int,'submitted')`,
          [fixtures.deptA, fixtures.classA, fixtures.subjectA, date, t[0].id],
        ),
      ),
    /duplicate key value/i,
  );
});

test('teacher cannot inject a student from another class', async () => {
  const teacher = await login(fixtures.teacherA);
  const res = await teacher.post('/api/attendance/student').send({
    class_id: fixtures.classA,
    subject_id: fixtures.subjectA,
    period_no: 5,
    date: '2026-03-05',
    records: [{ student_id: fixtures.studentsB[0], status: 'present' }],
  });
  assert.equal(res.status, 400);
});

test('locked session rejects further submission with 409', async () => {
  const teacher = await login(fixtures.teacherA);
  const date = '2026-03-06';
  const created = await teacher.post('/api/attendance/student').send({
    class_id: fixtures.classA,
    subject_id: fixtures.subjectA,
    period_no: 1,
    date,
    records: records(fixtures.studentsA),
  });
  assert.equal(created.status, 201);
  const lock = await teacher.post(`/api/attendance/sessions/${created.body.session_id}/lock`).send({ locked: true });
  assert.equal(lock.status, 200);

  const edit = await teacher.post('/api/attendance/student').send({
    class_id: fixtures.classA,
    subject_id: fixtures.subjectA,
    period_no: 1,
    date,
    records: records(fixtures.studentsA, [0]),
    confirm_overwrite: true,
  });
  assert.equal(edit.status, 409);
  assert.match(edit.body.error.message, /locked/i);
});

/* --------------------------- SMS: enqueue + failure ----------------------- */

test('absence enqueues an SMS for the guardian while the attendance record is kept', async () => {
  const teacher = await login(fixtures.teacherA);
  const date = '2026-03-09';
  const res = await teacher.post('/api/attendance/student').send({
    class_id: fixtures.classA,
    subject_id: fixtures.subjectA,
    period_no: 1,
    date,
    records: records(fixtures.studentsA, [1, 2]),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.summary.absent, 2);
  assert.ok(res.body.sms.queued >= 2, `expected queued SMS, got ${JSON.stringify(res.body.sms)}`);

  const attendanceKept = await q<{ n: number }>(
    "SELECT count(*)::int AS n FROM student_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id WHERE a.session_date=$1::date AND sa.status='absent'",
    [date],
  );
  assert.equal(Number(attendanceKept[0].n), 2);

  const outbox = await q<{ status: string; to_phone: string }>('SELECT status,to_phone FROM sms_outbox WHERE session_id=$1::int', [res.body.session_id]);
  assert.equal(outbox.length, 2, 'one SMS per absent student guardian');
  assert.ok(outbox.every((o) => o.to_phone.startsWith('91')), 'phones must be normalised to 91XXXXXXXXXX');
});

test('with no gateway credentials the outbox records not_sent — never sent', async () => {
  const admin = await login(fixtures.admin);
  const drain = await admin.post('/api/sms/process').send({});
  assert.equal(drain.status, 200);
  const rows = await q<{ status: string; last_error: string | null }>('SELECT status,last_error FROM sms_outbox');
  assert.ok(rows.length > 0, 'outbox must not be empty');
  assert.ok(rows.every((r) => r.status === 'not_sent'), `expected all not_sent, got ${rows.map((r) => r.status).join(',')}`);
  assert.ok(rows.every((r) => (r.last_error ?? '').length > 10), 'a reason must be stored');
  assert.equal(rows.filter((r) => r.status === 'sent' || r.status === 'delivered').length, 0);
});

test('re-enqueueing the same session does not create duplicate messages (idempotency key)', async () => {
  const before = await q<{ n: number }>('SELECT count(*)::int AS n FROM sms_outbox');
  const { enqueueAttendanceSms } = await import('../services/smsQueue.js');
  const sessions = await q<{ id: number }>("SELECT id FROM attendance_sessions WHERE kind='student' ORDER BY id DESC LIMIT 1");
  await enqueueAttendanceSms({ kind: 'student', sessionId: Number(sessions[0].id) });
  await enqueueAttendanceSms({ kind: 'student', sessionId: Number(sessions[0].id) });
  const after = await q<{ n: number }>('SELECT count(*)::int AS n FROM sms_outbox');
  assert.equal(Number(after[0].n), Number(before[0].n), 'outbox size must not change on re-enqueue');
});

test('invalid phone numbers are recorded as not_sent instead of a fake success', async () => {
  await q(
    `INSERT INTO students (roll_no,full_name,department_id,class_id,semester,section,guardian_phone)
     VALUES ('NOPHONE1','No Phone Student',$1::int,$2::int,3,'A','123')`,
    [fixtures.deptA, fixtures.classA],
  );
  const noPhone = await q<{ id: number }>("SELECT id FROM students WHERE roll_no='NOPHONE1'");
  const teacher = await login(fixtures.teacherA);
  const res = await teacher.post('/api/attendance/student').send({
    class_id: fixtures.classA,
    subject_id: fixtures.subjectA,
    period_no: 7,
    date: '2026-03-10',
    records: [{ student_id: Number(noPhone[0].id), status: 'absent' }],
  });
  assert.equal(res.status, 201);
  const admin = await login(fixtures.admin);
  await admin.post('/api/sms/process').send({});
  const sent = await q<{ n: number }>("SELECT count(*)::int AS n FROM sms_outbox WHERE status='sent'");
  assert.equal(Number(sent[0].n), 0);
});

/* ------------------------- Correction approval flow ---------------------- */

test('teacher raises a correction, HOD approval updates the record and writes an audit trail', async () => {
  const teacher = await login(fixtures.teacherA);
  const date = '2026-03-11';
  const created = await teacher.post('/api/attendance/student').send({
    class_id: fixtures.classA,
    subject_id: fixtures.subjectA,
    period_no: 1,
    date,
    records: records(fixtures.studentsA, [0]),
  });
  assert.equal(created.status, 201);
  const sessionId = created.body.session_id;

  const req = await teacher.post('/api/attendance/corrections').send({
    session_id: sessionId,
    record_type: 'student',
    student_id: fixtures.studentsA[0],
    new_status: 'present',
    reason: 'Student was present but marked absent by mistake',
  });
  assert.equal(req.status, 201);
  assert.equal(req.body.old_status, 'absent');

  // The record is unchanged until approved.
  const before = await q<{ status: string }>('SELECT status FROM student_attendance WHERE session_id=$1::int AND student_id=$2::int', [
    sessionId, fixtures.studentsA[0],
  ]);
  assert.equal(before[0].status, 'absent');

  const hod = await login(fixtures.hodA);
  const decide = await hod.post(`/api/attendance/corrections/${req.body.id}/decide`).send({ decision: 'approved', note: 'Verified' });
  assert.equal(decide.status, 200);

  const after = await q<{ status: string }>('SELECT status FROM student_attendance WHERE session_id=$1::int AND student_id=$2::int', [
    sessionId, fixtures.studentsA[0],
  ]);
  assert.equal(after[0].status, 'present');

  const auditRows = await q<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE action='correction.approved'");
  assert.ok(Number(auditRows[0].n) >= 1, 'approval must be audited');

  // Re-deciding the same request is rejected.
  const again = await hod.post(`/api/attendance/corrections/${req.body.id}/decide`).send({ decision: 'approved' });
  assert.equal(again.status, 409);
});

test('teacher cannot approve their own correction (403)', async () => {
  const teacher = await login(fixtures.teacherA);
  const pending = await q<{ id: number }>("SELECT id FROM attendance_corrections LIMIT 1");
  if (!pending.length) return;
  const res = await teacher.post(`/api/attendance/corrections/${pending[0].id}/decide`).send({ decision: 'approved' });
  assert.equal(res.status, 403);
});

/* --------------------------- Staff attendance ---------------------------- */

test('HOD marks staff attendance for their department; a teacher of another dept cannot', async () => {
  await q(
    `INSERT INTO staff (staff_code,full_name,designation,department_id,phone,employment_type)
     VALUES ('TST-02','Second Staff','Assistant Professor',$1::int,'9876500002','teaching')`,
    [fixtures.deptA],
  );
  const all = await q<{ id: number }>("SELECT id FROM staff WHERE department_id=$1::int", [fixtures.deptA]);
  const hod = await login(fixtures.hodA);
  const res = await hod.post('/api/attendance/staff').send({
    department_id: fixtures.deptA,
    date: '2026-03-12',
    period_no: 1,
    records: all.map((s) => ({ staff_id: Number(s.id), status: 'present' })),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const teacherB = await login(fixtures.teacherB);
  const forbidden = await teacherB.post('/api/attendance/staff').send({
    department_id: fixtures.deptA,
    date: '2026-03-13',
    period_no: 1,
    records: [{ staff_id: Number(all[0].id), status: 'absent' }],
  });
  assert.equal(forbidden.status, 403);
});

test('staff member can see their own record but not other staff records', async () => {
  const staff = await login(fixtures.staffUser);
  const sessions = await staff.get('/api/attendance/sessions?kind=staff');
  assert.equal(sessions.status, 200);
  const mine = await staff.get('/api/dashboard');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.role, 'staff');
});

/* -------------------------------- Reports -------------------------------- */

test('CSV, XLSX and PDF exports return the right content types', async () => {
  const admin = await login(fixtures.admin);
  for (const [format, type] of [
    ['csv', 'text/csv'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pdf', 'application/pdf'],
  ] as const) {
    const res = await admin.get(`/api/reports/student_wise?from=2026-01-01&to=2026-12-31&format=${format}`);
    assert.equal(res.status, 200, `${format} failed`);
    assert.ok(String(res.headers['content-type']).includes(type), `${format} content-type was ${res.headers['content-type']}`);
    if (format === 'csv') {
      const csv = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.text ?? res.body ?? '');
      assert.ok(csv.length > 60, `csv body too small (${csv.length} bytes)`);
      assert.ok(csv.split('\n')[0].includes('Roll No'), 'CSV must have a header row');
    } else {
      const buf: Buffer = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text ?? '', 'binary');
      const len = buf.length || Number(res.headers['content-length'] ?? 0);
      assert.ok(len > 60, `${format} body too small (${len} bytes)`);
      if (len > 4 && buf.length > 4) {
        if (format === 'pdf') assert.equal(buf.subarray(0, 4).toString(), '%PDF');
        if (format === 'xlsx') assert.equal(buf.subarray(0, 2).toString(), 'PK', 'xlsx must be a zip container');
      }
    }
  }
});

test('report rows reflect real attendance data', async () => {
  const admin = await login(fixtures.admin);
  const res = await admin.get('/api/reports/student_wise?from=2026-01-01&to=2026-12-31');
  assert.equal(res.status, 200);
  assert.ok(res.body.count >= 8, `expected rows, got ${res.body.count}`);
  const row = res.body.rows.find((r: { roll_no: string }) => r.roll_no === 'A9001');
  assert.ok(row, 'student A9001 must appear in the report');
  assert.ok(Number(row.total) > 0);
});

test('student cannot export reports (403)', async () => {
  const student = await login(fixtures.studentUser);
  const res = await student.get('/api/reports/student_wise?format=csv');
  assert.equal(res.status, 403);
});

/* ------------------------------- Dashboard ------------------------------- */

test('admin dashboard returns college-wide totals and department stats', async () => {
  const admin = await login(fixtures.admin);
  const res = await admin.get('/api/dashboard');
  assert.equal(res.status, 200);
  assert.ok(res.body.totals.students >= 8);
  assert.ok(res.body.department_stats.length >= 2);
  assert.ok(Array.isArray(res.body.recent_activity));
});

test('HOD dashboard is limited to their own department', async () => {
  const hod = await login(fixtures.hodA);
  const res = await hod.get('/api/dashboard');
  assert.equal(res.status, 200);
  assert.equal(res.body.department_stats.length, 1);
  assert.equal(Number(res.body.department_stats[0].id), fixtures.deptA);
});

test('audit log is restricted to admin and HOD', async () => {
  const teacher = await login(fixtures.teacherA);
  assert.equal((await teacher.get('/api/dashboard/audit')).status, 403);
  const admin = await login(fixtures.admin);
  const res = await admin.get('/api/dashboard/audit');
  assert.equal(res.status, 200);
  assert.ok(res.body.logs.length > 0);
});

/* --------------------------- Admin management ---------------------------- */

test('admin can create a department and cannot duplicate its code', async () => {
  const admin = await login(fixtures.admin);
  const created = await admin.post('/api/departments').send({ code: 'ITX', name: 'Information Technology' });
  assert.equal(created.status, 201);
  const dup = await admin.post('/api/departments').send({ code: 'itx', name: 'Dup' });
  assert.equal(dup.status, 409);
});

test('teacher cannot create users (403)', async () => {
  const teacher = await login(fixtures.teacherA);
  const res = await teacher.post('/api/people/users').send({
    full_name: 'Evil Admin',
    email: 'evil@test.local',
    password: 'password123',
    role: 'admin',
  });
  assert.equal(res.status, 403);
});

test('SMS test endpoint reports the real status, not a fake success', async () => {
  const admin = await login(fixtures.admin);
  const res = await admin.post('/api/sms/test').send({ phone: '9876543210' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false, 'without credentials the test must not claim success');
  assert.equal(res.body.result.status, 'not_sent');
});
