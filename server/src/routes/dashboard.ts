import { Router } from 'express';
import { one, q } from '../db/index.js';
import { ah, forbidden } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { todayISO } from '../lib/types.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get(
  '/',
  ah(async (req, res) => {
    const u = req.user!;
    const dept = u.role === 'admin' ? null : u.department_id;
    const today = todayISO();

    if (u.role === 'student' && u.student_id) {
      const summary = await q(
        `SELECT sub.code AS subject_code, sub.name AS subject_name,
                count(*)::int AS total,
                sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS present,
                sum(CASE WHEN sa.status='absent' THEN 1 ELSE 0 END)::int AS absent,
                ROUND(100.0 * sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END) / GREATEST(count(*),1), 1) AS percentage
           FROM student_attendance sa
           JOIN attendance_sessions a ON a.id = sa.session_id
           JOIN subjects sub ON sub.id = a.subject_id
          WHERE sa.student_id = $1
          GROUP BY sub.code, sub.name ORDER BY sub.code`,
        [u.student_id],
      );
      const overall = await one<{ total: number; present: number; percentage: number }>(
        `SELECT count(*)::int AS total,
                sum(CASE WHEN status='present' THEN 1 ELSE 0 END)::int AS present,
                ROUND(100.0 * sum(CASE WHEN status='present' THEN 1 ELSE 0 END) / GREATEST(count(*),1), 1) AS percentage
           FROM student_attendance WHERE student_id = $1`,
        [u.student_id],
      );
      return res.json({ role: 'student', overview: overall, by_subject: summary, today });
    }

    if (u.role === 'staff' && u.staff_id) {
      const rows = await q(
        `SELECT to_char(a.session_date,'YYYY-MM') AS month,
                count(*)::int AS total,
                sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS present,
                sum(CASE WHEN sa.status='absent' THEN 1 ELSE 0 END)::int AS absent
           FROM staff_attendance sa JOIN attendance_sessions a ON a.id = sa.session_id
          WHERE sa.staff_id = $1 GROUP BY 1 ORDER BY 1 DESC LIMIT 6`,
        [u.staff_id],
      );
      return res.json({ role: 'staff', monthly: rows, today });
    }

    const totals = await one<{
      students: number;
      staff: number;
      teaching: number;
      non_teaching: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM students s JOIN departments d ON d.id=s.department_id WHERE s.active AND ($1::int IS NULL OR s.department_id=$1)) AS students,
        (SELECT count(*)::int FROM staff sf JOIN departments d ON d.id=sf.department_id WHERE sf.employment_status='active' AND ($1::int IS NULL OR sf.department_id=$1)) AS staff,
        (SELECT count(*)::int FROM staff sf WHERE sf.employment_status='active' AND sf.employment_type='teaching' AND ($1::int IS NULL OR sf.department_id=$1)) AS teaching,
        (SELECT count(*)::int FROM staff sf WHERE sf.employment_status='active' AND sf.employment_type='non_teaching' AND ($1::int IS NULL OR sf.department_id=$1)) AS non_teaching`,
      [dept],
    );

    const dayStats = await one<{
      student_present: number;
      student_absent: number;
      student_leave: number;
      staff_present: number;
      staff_absent: number;
      staff_leave: number;
      staff_half: number;
      sessions: number;
    }>(
      `SELECT
        COALESCE((SELECT count(*)::int FROM student_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id
                   WHERE a.session_date=$1 AND sa.status='present' AND ($2::int IS NULL OR a.department_id=$2)),0) AS student_present,
        COALESCE((SELECT count(*)::int FROM student_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id
                   WHERE a.session_date=$1 AND sa.status='absent' AND ($2::int IS NULL OR a.department_id=$2)),0) AS student_absent,
        COALESCE((SELECT count(*)::int FROM student_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id
                   WHERE a.session_date=$1 AND sa.status='leave' AND ($2::int IS NULL OR a.department_id=$2)),0) AS student_leave,
        COALESCE((SELECT count(*)::int FROM staff_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id
                   WHERE a.session_date=$1 AND sa.status='present' AND ($2::int IS NULL OR a.department_id=$2)),0) AS staff_present,
        COALESCE((SELECT count(*)::int FROM staff_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id
                   WHERE a.session_date=$1 AND sa.status='absent' AND ($2::int IS NULL OR a.department_id=$2)),0) AS staff_absent,
        COALESCE((SELECT count(*)::int FROM staff_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id
                   WHERE a.session_date=$1 AND sa.status='leave' AND ($2::int IS NULL OR a.department_id=$2)),0) AS staff_leave,
        COALESCE((SELECT count(*)::int FROM staff_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id
                   WHERE a.session_date=$1 AND sa.status='half_day' AND ($2::int IS NULL OR a.department_id=$2)),0) AS staff_half,
        COALESCE((SELECT count(*)::int FROM attendance_sessions a WHERE a.session_date=$1 AND ($2::int IS NULL OR a.department_id=$2)),0) AS sessions`,
      [today, dept],
    );

    const deptStats = await q(
      `SELECT d.id, d.code, d.name,
              (SELECT count(*)::int FROM students s WHERE s.department_id=d.id AND s.active) AS students,
              COALESCE((SELECT count(*)::int FROM student_attendance sa
                 JOIN attendance_sessions a ON a.id=sa.session_id
                WHERE a.department_id=d.id AND a.session_date=$1 AND sa.status='present'),0) AS present,
              COALESCE((SELECT count(*)::int FROM student_attendance sa
                 JOIN attendance_sessions a ON a.id=sa.session_id
                WHERE a.department_id=d.id AND a.session_date=$1 AND sa.status='absent'),0) AS absent,
              COALESCE((SELECT count(*)::int FROM staff_attendance sa
                 JOIN attendance_sessions a ON a.id=sa.session_id
                WHERE a.department_id=d.id AND a.session_date=$1 AND sa.status='present'),0) AS staff_present,
              COALESCE((SELECT count(*)::int FROM staff_attendance sa
                 JOIN attendance_sessions a ON a.id=sa.session_id
                WHERE a.department_id=d.id AND a.session_date=$1 AND sa.status='absent'),0) AS staff_absent
         FROM departments d
        WHERE d.active AND ($2::boolean OR d.id = $3)
        ORDER BY d.code`,
      [today, u.role === 'admin', dept],
    );

    const recent = await q(
      `SELECT a.id, a.kind, a.session_date, a.period_no, a.status, a.submitted_at,
              d.code AS department_code, c.name AS class_name, sub.code AS subject_code,
              u.full_name AS taken_by,
              (SELECT count(*)::int FROM student_attendance x WHERE x.session_id=a.id) AS student_count,
              (SELECT count(*)::int FROM student_attendance x WHERE x.session_id=a.id AND x.status='absent') AS absent_count
         FROM attendance_sessions a
         JOIN departments d ON d.id=a.department_id
         LEFT JOIN classes c ON c.id=a.class_id
         LEFT JOIN subjects sub ON sub.id=a.subject_id
         JOIN users u ON u.id=a.taken_by_user_id
        WHERE ($1::int IS NULL OR a.department_id=$1)
        ORDER BY a.submitted_at DESC NULLS LAST LIMIT 8`,
      [dept],
    );

    const pending = await q(
      `SELECT d.code AS department_code, count(*)::int AS unmarked_classes
         FROM classes c JOIN departments d ON d.id=c.department_id
        WHERE c.active AND ($1::int IS NULL OR c.department_id=$1)
          AND NOT EXISTS (
            SELECT 1 FROM attendance_sessions a
             WHERE a.class_id=c.id AND a.session_date=$2 AND a.kind='student')
        GROUP BY d.code ORDER BY d.code`,
      [dept, today],
    );

    // Students below the default 75% overall attendance threshold.
    // The department filter follows the same scope as the rest of this dashboard.
    const lowAttendance = await q(
      `SELECT low.*, count(*) OVER()::int AS low_attendance_count
         FROM (
         SELECT s.id AS student_id, s.roll_no, s.full_name, c.name AS class_name, c.section,
                count(sa.id)::int AS total_classes,
                sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS attended,
                ROUND(100.0 * sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)
                      / GREATEST(count(sa.id), 1), 1) AS percentage
           FROM students s
           JOIN classes c ON c.id=s.class_id
           JOIN student_attendance sa ON sa.student_id=s.id
           JOIN attendance_sessions a ON a.id=sa.session_id
          WHERE s.active AND ($1::int IS NULL OR s.department_id=$1)
          GROUP BY s.id, s.roll_no, s.full_name, c.name, c.section
       ) low
       WHERE percentage < 75
       ORDER BY percentage ASC, roll_no
       LIMIT 10`,
      [dept],
    );

    const pendingCorrections = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM attendance_corrections c
         JOIN attendance_sessions a ON a.id=c.session_id
        WHERE c.status='pending' AND ($1::int IS NULL OR a.department_id=$1)`,
      [dept],
    );

    const weekTrend = await q(
      `SELECT a.session_date::text AS date,
              ROUND(100.0 * sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END) / GREATEST(count(*),1),1) AS percentage
         FROM student_attendance sa JOIN attendance_sessions a ON a.id=sa.session_id
        WHERE a.session_date >= (CURRENT_DATE - INTERVAL '13 days') AND ($1::int IS NULL OR a.department_id=$1)
        GROUP BY a.session_date ORDER BY a.session_date`,
      [dept],
    );

    const smsStats = await q<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM sms_outbox GROUP BY status`,
    );

    res.json({
      role: u.role,
      today,
      totals,
      day_stats: dayStats,
      department_stats: deptStats,
      recent_activity: recent,
      pending_submissions: pending,
      low_attendance: lowAttendance,
      low_attendance_count: Number(lowAttendance[0]?.low_attendance_count ?? 0),
      pending_corrections: pendingCorrections?.n ?? 0,
      week_trend: weekTrend,
      sms_stats: smsStats,
    });
  }),
);

dashboardRouter.get(
  '/audit',
  ah(async (req, res) => {
    if (!['admin', 'hod'].includes(req.user!.role)) throw forbidden('Audit logs are restricted.');
    const limit = Math.min(Number(req.query.limit ?? 100), 300);
    const rows = await q(
      `SELECT l.id, l.action, l.entity, l.entity_id, l.created_at, l.ip, u.full_name AS actor
         FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_user_id
        ORDER BY l.created_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ logs: rows });
  }),
);

dashboardRouter.get(
  '/notifications',
  ah(async (req, res) => {
    const rows = await q(
      'SELECT id, title, body, read_at, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user!.id],
    );
    res.json({ notifications: rows });
  }),
);

dashboardRouter.post(
  '/notifications/read',
  ah(async (req, res) => {
    await q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user!.id]);
    res.json({ ok: true });
  }),
);
