import { Router } from 'express';
import { z } from 'zod';
import { one, q, tx } from '../db/index.js';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { canMarkStaffAttendance, canMarkStudentAttendance, requireAuth } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { isValidDate, prettyDate, todayISO } from '../lib/types.js';
import { enqueueAttendanceSms } from '../services/smsQueue.js';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

const statusEnum = z.enum(['present', 'absent', 'leave']);

/* ========================= Student attendance ========================= */

/** Context the teacher picks: their own assignments (or all classes for admin/HOD). */
attendanceRouter.get(
  '/student/context',
  ah(async (req, res) => {
    const u = req.user!;
    const assignments = await q(
      `SELECT ta.class_id, c.name AS class_name, c.semester, c.section,
              ta.subject_id, sub.code AS subject_code, sub.name AS subject_name,
              ta.department_id, d.code AS department_code, d.name AS department_name
         FROM teacher_assignments ta
         JOIN classes c ON c.id = ta.class_id
         JOIN subjects sub ON sub.id = ta.subject_id
         JOIN departments d ON d.id = ta.department_id
        WHERE ta.active AND ($1::boolean OR ta.teacher_user_id = $2)
          AND ($3::int IS NULL OR ta.department_id = $3)
        ORDER BY d.code, c.semester, c.section, sub.code`,
      [u.role === 'admin', u.id, u.role === 'admin' ? null : u.department_id],
    );
    res.json({ assignments, today: todayISO() });
  }),
);

/** Loads the roster for a context; reports an existing session so duplicates are visible. */
attendanceRouter.get(
  '/student/roster',
  ah(async (req, res) => {
    const u = req.user!;
    const classId = Number(req.query.class_id);
    const subjectId = Number(req.query.subject_id);
    const periodNo = Number(req.query.period_no);
    const date = String(req.query.date ?? '');
    if (!classId || !subjectId || !periodNo || !isValidDate(date)) throw badRequest('Select class, subject, period and a valid date.');

    if (!(await canMarkStudentAttendance(u, classId, subjectId))) {
      throw forbidden('You are not assigned to this class and subject.');
    }

    const existing = await one<{ id: number; status: string; taken_by: string }>(
      `SELECT a.id, a.status, u.full_name AS taken_by
         FROM attendance_sessions a JOIN users u ON u.id = a.taken_by_user_id
        WHERE a.kind='student' AND a.class_id=$1 AND a.subject_id=$2 AND a.session_date=$3 AND a.period_no=$4`,
      [classId, subjectId, date, periodNo],
    );

    const students = await q(
      `SELECT s.id, s.roll_no, s.full_name, s.phone, s.guardian_phone
         FROM students s WHERE s.class_id = $1 AND s.active ORDER BY s.roll_no`,
      [classId],
    );

    const subject = await one<{ code: string; name: string }>('SELECT code, name FROM subjects WHERE id = $1', [subjectId]);
    const cls = await one<{ name: string; section: string }>('SELECT name, section FROM classes WHERE id = $1', [classId]);
    const period = await one<{ label: string }>('SELECT label FROM periods WHERE period_no = $1', [periodNo]);

    res.json({
      students,
      subject,
      class: cls,
      period,
      date,
      session: existing
        ? { id: Number(existing.id), status: existing.status, taken_by: existing.taken_by }
        : null,
    });
  }),
);

const markSchema = z.object({
  class_id: z.number().int().positive(),
  subject_id: z.number().int().positive(),
  period_no: z.number().int().min(1).max(12),
  date: z.string(),
  notes: z.string().max(500).optional(),
  records: z
    .array(z.object({ student_id: z.number().int().positive(), status: statusEnum, remark: z.string().max(200).optional() }))
    .min(1, 'Mark at least one student.'),
  confirm_overwrite: z.boolean().optional(),
});

/** Submits (creates or replaces a draft) a student attendance session. */
attendanceRouter.post(
  '/student',
  ah(async (req, res) => {
    const u = req.user!;
    const parsed = markSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid attendance data.');
    const d = parsed.data;
    if (!isValidDate(d.date)) throw badRequest('Invalid date.');

    if (!(await canMarkStudentAttendance(u, d.class_id, d.subject_id))) {
      throw forbidden('You are not assigned to this class and subject.');
    }

    // Every record must belong to the class being marked — prevents cross-class injection.
    const roster = await q<{ id: number }>('SELECT id FROM students WHERE class_id = $1 AND active', [d.class_id]);
    const rosterIds = new Set(roster.map((r) => Number(r.id)));
    for (const rec of d.records) {
      if (!rosterIds.has(rec.student_id)) throw badRequest(`Student ${rec.student_id} is not in this class.`);
    }

    const result = await tx(async (t) => {
      const existing = await t.one<{ id: number; status: string }>(
        `SELECT id, status FROM attendance_sessions
          WHERE kind='student' AND class_id=$1 AND subject_id=$2 AND session_date=$3 AND period_no=$4`,
        [d.class_id, d.subject_id, d.date, d.period_no],
      );

      if (existing && existing.status === 'locked') {
        throw conflict('This session is locked. Request a correction from your HOD instead.');
      }
      if (existing && !d.confirm_overwrite) {
        throw conflict('Attendance for this class, subject and period is already recorded.', {
          requires_confirmation: true,
          session_id: Number(existing.id),
        });
      }

      let sessionId: number;
      if (existing) {
        sessionId = Number(existing.id);
        await t.q(
          `UPDATE attendance_sessions SET status='submitted', submitted_at=now(), updated_at=now(),
                  taken_by_user_id=$2, notes=$3 WHERE id=$1`,
          [sessionId, u.id, d.notes ?? null],
        );
        await t.q('DELETE FROM student_attendance WHERE session_id = $1', [sessionId]);
      } else {
        const created = await t.one<{ id: number }>(
          `INSERT INTO attendance_sessions
             (kind, department_id, class_id, subject_id, period_no, session_date, taken_by_user_id, status, notes, submitted_at)
           VALUES ('student',
                   (SELECT department_id FROM classes WHERE id=$1), $1, $2, $3, $4, $5, 'submitted', $6, now())
           RETURNING id`,
          [d.class_id, d.subject_id, d.period_no, d.date, u.id, d.notes ?? null],
        );
        sessionId = Number(created!.id);
      }

      const seen = new Set<number>();
      for (const rec of d.records) {
        if (seen.has(rec.student_id)) throw badRequest('Duplicate student in the submission.');
        seen.add(rec.student_id);
        await t.q(
          `INSERT INTO student_attendance (session_id, student_id, status, remark, marked_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [sessionId, rec.student_id, rec.status, rec.remark ?? null, u.id],
        );
      }
      return { sessionId, replaced: Boolean(existing) };
    });

    const before = await one('SELECT * FROM attendance_sessions WHERE id = $1', [result.sessionId]);
    await audit({
      actorUserId: u.id,
      action: result.replaced ? 'attendance.student.replace' : 'attendance.student.create',
      entity: 'attendance_sessions',
      entityId: result.sessionId,
      after: { date: d.date, class_id: d.class_id, subject_id: d.subject_id, period_no: d.period_no, counts: summarize(d.records) },
      req,
    });

    // SMS enqueue happens after the attendance transaction commits: a gateway problem can
    // never roll back or lose an attendance record.
    const sms = await enqueueAttendanceSms({ kind: 'student', sessionId: result.sessionId });

    res.status(201).json({
      ok: true,
      session_id: result.sessionId,
      replaced: result.replaced,
      summary: summarize(d.records),
      session: before,
      sms,
    });
  }),
);

function summarize(records: { status: string }[]) {
  return {
    total: records.length,
    present: records.filter((r) => r.status === 'present').length,
    absent: records.filter((r) => r.status === 'absent').length,
    leave: records.filter((r) => r.status === 'leave').length,
  };
}

/** Lock/unlock a session (submitted → locked so it cannot be edited). */
attendanceRouter.post(
  '/sessions/:id/lock',
  ah(async (req, res) => {
    const u = req.user!;
    const id = Number(req.params.id);
    const locked = req.body?.locked !== false;
    const s = await one<{ id: number; status: string; department_id: number; taken_by_user_id: number; class_id: number | null; subject_id: number | null }>(
      'SELECT id, status, department_id, taken_by_user_id, class_id, subject_id FROM attendance_sessions WHERE id = $1',
      [id],
    );
    if (!s) throw notFound('Session not found.');
    if (u.role === 'teacher') {
      if (Number(s.taken_by_user_id) !== u.id) throw forbidden('Only the teacher who took this session can lock it.');
    } else if (u.role === 'hod' && Number(s.department_id) !== u.department_id) {
      throw forbidden('This session belongs to another department.');
    }
    if (locked && s.status === 'locked') throw conflict('This session is already locked.');
    await q(
      `UPDATE attendance_sessions SET status = $2, locked_at = CASE WHEN $2='locked' THEN now() ELSE NULL END,
              updated_at = now() WHERE id = $1`,
      [id, locked ? 'locked' : 'submitted'],
    );
    await audit({ actorUserId: u.id, action: locked ? 'attendance.lock' : 'attendance.unlock', entity: 'attendance_sessions', entityId: id, req });
    res.json({ ok: true, status: locked ? 'locked' : 'submitted' });
  }),
);

/** Session history with filters. */
attendanceRouter.get(
  '/sessions',
  ah(async (req, res) => {
    const u = req.user!;
    const dept = u.role === 'admin' ? (req.query.department_id ? Number(req.query.department_id) : null) : u.department_id;
    const from = String(req.query.from ?? '') || '1970-01-01';
    const to = String(req.query.to ?? '') || '2999-12-31';
    const classId = req.query.class_id ? Number(req.query.class_id) : null;
    const subjectId = req.query.subject_id ? Number(req.query.subject_id) : null;
    const kind = (req.query.kind as string) === 'staff' ? 'staff' : (req.query.kind as string) === 'student' ? 'student' : null;
    const mineOnly = req.query.mine === '1';

    const rows = await q(
      `SELECT a.id, a.kind, a.session_date, a.period_no, a.status, a.submitted_at, a.locked_at, a.is_demo,
              d.code AS department_code, c.name AS class_name, c.section,
              sub.code AS subject_code, sub.name AS subject_name,
              u.full_name AS taken_by,
              (SELECT count(*)::int FROM student_attendance x WHERE x.session_id = a.id AND x.status='present') AS present,
              (SELECT count(*)::int FROM student_attendance x WHERE x.session_id = a.id AND x.status='absent') AS absent,
              (SELECT count(*)::int FROM student_attendance x WHERE x.session_id = a.id AND x.status='leave') AS on_leave,
              (SELECT count(*)::int FROM staff_attendance x WHERE x.session_id = a.id AND x.status='present') AS staff_present,
              (SELECT count(*)::int FROM staff_attendance x WHERE x.session_id = a.id AND x.status='absent') AS staff_absent
         FROM attendance_sessions a
         JOIN departments d ON d.id = a.department_id
         LEFT JOIN classes c ON c.id = a.class_id
         LEFT JOIN subjects sub ON sub.id = a.subject_id
         JOIN users u ON u.id = a.taken_by_user_id
        WHERE ($1::int IS NULL OR a.department_id = $1)
          AND ($2::date IS NULL OR a.session_date >= $2::date)
          AND ($3::date IS NULL OR a.session_date <= $3::date)
          AND ($4::int IS NULL OR a.class_id = $4)
          AND ($5::int IS NULL OR a.subject_id = $5)
          AND ($6::text IS NULL OR a.kind = $6)
          AND ($7::boolean = FALSE OR a.taken_by_user_id = $8)
        ORDER BY a.session_date DESC, a.period_no DESC
        LIMIT 300`,
      [dept, from, to, classId, subjectId, kind, mineOnly, u.id],
    );
    res.json({ sessions: rows });
  }),
);

attendanceRouter.get(
  '/sessions/:id',
  ah(async (req, res) => {
    const u = req.user!;
    const id = Number(req.params.id);
    const s = await one<Record<string, unknown>>(
      `SELECT a.*, d.code AS department_code, c.name AS class_name, sub.code AS subject_code, sub.name AS subject_name,
              u.full_name AS taken_by
         FROM attendance_sessions a
         JOIN departments d ON d.id = a.department_id
         LEFT JOIN classes c ON c.id = a.class_id
         LEFT JOIN subjects sub ON sub.id = a.subject_id
         JOIN users u ON u.id = a.taken_by_user_id
        WHERE a.id = $1`,
      [id],
    );
    if (!s) throw notFound('Session not found.');
    if (u.role !== 'admin' && Number(s.department_id) !== u.department_id) throw forbidden('This session is outside your department.');

    const studentRecords = await q(
      `SELECT sa.id, sa.student_id, st.roll_no, st.full_name, sa.status, sa.remark
         FROM student_attendance sa JOIN students st ON st.id = sa.student_id
        WHERE sa.session_id = $1 ORDER BY st.roll_no`,
      [id],
    );
    const staffRecords = await q(
      `SELECT sa.id, sa.staff_id, sf.staff_code, sf.full_name, sf.designation, sa.status, sa.remark
         FROM staff_attendance sa JOIN staff sf ON sf.id = sa.staff_id
        WHERE sa.session_id = $1 ORDER BY sf.full_name`,
      [id],
    );
    res.json({ session: s, student_records: studentRecords, staff_records: staffRecords });
  }),
);

/* ========================== Staff attendance =========================== */

attendanceRouter.get(
  '/staff/roster',
  ah(async (req, res) => {
    const u = req.user!;
    const deptId = u.role === 'admin' ? Number(req.query.department_id) : u.department_id;
    const date = String(req.query.date ?? todayISO());
    const periodNo = Number(req.query.period_no ?? 1);
    if (!deptId) throw badRequest('Select a department.');
    if (!isValidDate(date)) throw badRequest('Invalid date.');
    if (!(await canMarkStaffAttendance(u, deptId))) throw forbidden('Only administrators and the department HOD can mark staff attendance.');

    const staff = await q(
      `SELECT id, staff_code, full_name, designation, employment_type, phone
         FROM staff WHERE department_id = $1 AND employment_status='active'
        ORDER BY employment_type, full_name`,
      [deptId],
    );
    const existing = await one<{ id: number; status: string }>(
      `SELECT id, status FROM attendance_sessions
        WHERE kind='staff' AND department_id=$1 AND session_date=$2 AND period_no=$3`,
      [deptId, date, periodNo],
    );
    const prior = existing
      ? await q('SELECT staff_id, status FROM staff_attendance WHERE session_id = $1', [Number(existing.id)])
      : [];
    res.json({ staff, session: existing ? { id: Number(existing.id), status: existing.status } : null, date, prior });
  }),
);

const staffMarkSchema = z.object({
  department_id: z.number().int().positive(),
  date: z.string(),
  period_no: z.number().int().min(1).max(12).default(1),
  records: z.array(z.object({ staff_id: z.number().int().positive(), status: z.enum(['present', 'absent', 'leave', 'half_day']), remark: z.string().max(200).optional() })).min(1),
  confirm_overwrite: z.boolean().optional(),
});

attendanceRouter.post(
  '/staff',
  ah(async (req, res) => {
    const u = req.user!;
    const parsed = staffMarkSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid staff attendance.');
    const d = parsed.data;
    if (!isValidDate(d.date)) throw badRequest('Invalid date.');
    if (!(await canMarkStaffAttendance(u, d.department_id))) throw forbidden('You cannot mark attendance for this department.');

    const deptStaff = await q<{ id: number }>('SELECT id FROM staff WHERE department_id = $1 AND employment_status = $2', [d.department_id, 'active']);
    const allowed = new Set(deptStaff.map((s) => Number(s.id)));
    for (const r of d.records) if (!allowed.has(r.staff_id)) throw badRequest('A staff member is outside this department.');

    const result = await tx(async (t) => {
      const existing = await t.one<{ id: number; status: string }>(
        `SELECT id, status FROM attendance_sessions
          WHERE kind='staff' AND department_id=$1 AND session_date=$2 AND period_no=$3`,
        [d.department_id, d.date, d.period_no],
      );
      if (existing && existing.status === 'locked') throw conflict('This staff attendance session is locked.');
      if (existing && !d.confirm_overwrite) {
        throw conflict('Staff attendance for this department, date and period already exists.', {
          requires_confirmation: true,
          session_id: Number(existing.id),
        });
      }
      let sessionId: number;
      if (existing) {
        sessionId = Number(existing.id);
        await t.q(`UPDATE attendance_sessions SET status='submitted', submitted_at=now(), taken_by_user_id=$2, updated_at=now() WHERE id=$1`, [sessionId, u.id]);
        await t.q('DELETE FROM staff_attendance WHERE session_id = $1', [sessionId]);
      } else {
        const created = await t.one<{ id: number }>(
          `INSERT INTO attendance_sessions (kind, department_id, session_date, period_no, taken_by_user_id, status, submitted_at)
           VALUES ('staff',$1,$2,$3,$4,'submitted',now()) RETURNING id`,
          [d.department_id, d.date, d.period_no, u.id],
        );
        sessionId = Number(created!.id);
      }
      for (const r of d.records) {
        await t.q('INSERT INTO staff_attendance (session_id, staff_id, status, remark, marked_by) VALUES ($1,$2,$3,$4,$5)', [
          sessionId,
          r.staff_id,
          r.status,
          r.remark ?? null,
          u.id,
        ]);
      }
      return { sessionId, replaced: Boolean(existing) };
    });

    await audit({ actorUserId: u.id, action: 'attendance.staff.submit', entity: 'attendance_sessions', entityId: result.sessionId, after: { date: d.date, department_id: d.department_id }, req });
    const sms = await enqueueAttendanceSms({ kind: 'staff', sessionId: result.sessionId });
    res.status(201).json({ ok: true, session_id: result.sessionId, replaced: result.replaced, sms });
  }),
);

/* ======================= Correction request flow ======================= */

attendanceRouter.post(
  '/corrections',
  ah(async (req, res) => {
    const u = req.user!;
    const parsed = z
      .object({
        session_id: z.number().int().positive(),
        record_type: z.enum(['student', 'staff']),
        student_id: z.number().int().positive().optional(),
        staff_id: z.number().int().positive().optional(),
        new_status: z.enum(['present', 'absent', 'leave', 'half_day']),
        reason: z.string().trim().min(5, 'Please give a short reason (at least 5 characters).').max(500),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid correction request.');
    const d = parsed.data;

    const session = await one<{ id: number; department_id: number; status: string }>(
      'SELECT id, department_id, status FROM attendance_sessions WHERE id = $1',
      [d.session_id],
    );
    if (!session) throw notFound('Session not found.');
    if (u.role === 'teacher' && Number(session.department_id) !== u.department_id) throw forbidden('Not your department.');

    let oldStatus: string | null = null;
    if (d.record_type === 'student') {
      if (!d.student_id) throw badRequest('student_id is required.');
      const rec = await one<{ status: string }>('SELECT status FROM student_attendance WHERE session_id=$1 AND student_id=$2', [d.session_id, d.student_id]);
      if (!rec) throw notFound('That student has no record in this session.');
      oldStatus = rec.status;
    } else {
      if (!d.staff_id) throw badRequest('staff_id is required.');
      const rec = await one<{ status: string }>('SELECT status FROM staff_attendance WHERE session_id=$1 AND staff_id=$2', [d.session_id, d.staff_id]);
      if (!rec) throw notFound('That staff member has no record in this session.');
      oldStatus = rec.status;
    }

    const row = await one<{ id: number }>(
      `INSERT INTO attendance_corrections (session_id, record_type, student_id, staff_id, old_status, new_status, reason, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [d.session_id, d.record_type, d.student_id ?? null, d.staff_id ?? null, oldStatus, d.new_status, d.reason, u.id],
    );
    await audit({ actorUserId: u.id, action: 'correction.request', entity: 'attendance_corrections', entityId: row!.id, after: { ...d, old_status: oldStatus }, req });
    res.status(201).json({ id: Number(row!.id), status: 'pending', old_status: oldStatus });
  }),
);

attendanceRouter.get(
  '/corrections',
  ah(async (req, res) => {
    const u = req.user!;
    const status = (req.query.status as string | undefined) ?? null;
    const dept = u.role === 'admin' ? null : u.department_id;
    const rows = await q(
      `SELECT c.id, c.session_id, c.record_type, c.old_status, c.new_status, c.reason, c.status,
              c.created_at, c.decided_at, c.decision_note,
              a.session_date, d.code AS department_code,
              COALESCE(st.full_name, sf.full_name) AS person_name,
              COALESCE(st.roll_no, sf.staff_code) AS person_code,
              ru.full_name AS requested_by_name, du.full_name AS decided_by_name
         FROM attendance_corrections c
         JOIN attendance_sessions a ON a.id = c.session_id
         JOIN departments d ON d.id = a.department_id
         LEFT JOIN students st ON st.id = c.student_id
         LEFT JOIN staff sf ON sf.id = c.staff_id
         JOIN users ru ON ru.id = c.requested_by
         LEFT JOIN users du ON du.id = c.decided_by
        WHERE ($1::int IS NULL OR a.department_id = $1)
          AND ($2::text IS NULL OR c.status = $2)
          AND ($3::text <> 'mine' OR c.requested_by = $4)
        ORDER BY c.created_at DESC LIMIT 200`,
      [dept, status, req.query.mine === '1' ? 'mine' : '', u.id],
    );
    res.json({ corrections: rows });
  }),
);

attendanceRouter.post(
  '/corrections/:id/decide',
  ah(async (req, res) => {
    const u = req.user!;
    if (!['admin', 'hod'].includes(u.role)) throw forbidden('Only the HOD or an administrator can approve corrections.');
    const id = Number(req.params.id);
    const parsed = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid decision.');

    const c = await one<{
      id: number;
      session_id: number;
      record_type: string;
      student_id: number | null;
      staff_id: number | null;
      new_status: string;
      old_status: string | null;
      status: string;
      department_id: number;
    }>(
      `SELECT c.*, a.department_id FROM attendance_corrections c JOIN attendance_sessions a ON a.id = c.session_id WHERE c.id = $1`,
      [id],
    );
    if (!c) throw notFound('Correction not found.');
    if (c.status !== 'pending') throw conflict('This correction has already been decided.');
    if (u.role === 'hod' && Number(c.department_id) !== u.department_id) throw forbidden('This correction is outside your department.');

    await tx(async (t) => {
      await t.q('UPDATE attendance_corrections SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1', [
        id,
        parsed.data.decision,
        u.id,
        parsed.data.note ?? null,
      ]);
      if (parsed.data.decision === 'approved') {
        if (c.record_type === 'student') {
          await t.q('UPDATE student_attendance SET status=$3, marked_by=$4, marked_at=now() WHERE session_id=$1 AND student_id=$2', [
            c.session_id,
            c.student_id,
            c.new_status,
            u.id,
          ]);
        } else {
          await t.q('UPDATE staff_attendance SET status=$3, marked_by=$4, marked_at=now() WHERE session_id=$1 AND staff_id=$2', [
            c.session_id,
            c.staff_id,
            c.new_status,
            u.id,
          ]);
        }
        await t.q('UPDATE attendance_sessions SET updated_at=now() WHERE id=$1', [c.session_id]);
      }
    });

    await audit({
      actorUserId: u.id,
      action: `correction.${parsed.data.decision}`,
      entity: 'attendance_corrections',
      entityId: id,
      before: { status: c.old_status },
      after: { status: parsed.data.decision === 'approved' ? c.new_status : c.old_status, note: parsed.data.note },
      req,
    });
    res.json({ ok: true, status: parsed.data.decision });
  }),
);
