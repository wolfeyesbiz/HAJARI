import { Router } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { one, q } from '../db/index.js';
import { ah, badRequest, forbidden } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { prettyDate, todayISO } from '../lib/types.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

type Row = Record<string, unknown>;

interface ReportDef {
  title: string;
  columns: { key: string; header: string; width?: number }[];
  load: (filters: Filters) => Promise<Row[]>;
}

interface Filters {
  dept: number | null;
  from: string;
  to: string;
  classId: number | null;
  subjectId: number | null;
  studentId: number | null;
  staffId: number | null;
  threshold: number;
}

function parseFilters(req: { query: Record<string, unknown>; user?: { role: string; department_id: number | null } }): Filters {
  const u = req.user!;
  const dept = u.role === 'admin' ? (req.query.department_id ? Number(req.query.department_id) : null) : u.department_id;
  return {
    dept,
    from: String(req.query.from ?? '') || '1970-01-01',
    to: String(req.query.to ?? '') || '2999-12-31',
    classId: req.query.class_id ? Number(req.query.class_id) : null,
    subjectId: req.query.subject_id ? Number(req.query.subject_id) : null,
    studentId: req.query.student_id ? Number(req.query.student_id) : null,
    staffId: req.query.staff_id ? Number(req.query.staff_id) : null,
    threshold: req.query.threshold ? Number(req.query.threshold) : 75,
  };
}

const REPORTS: Record<string, ReportDef> = {
  daily_register: {
    title: 'Daily attendance register',
    columns: [
      { key: 'session_date', header: 'Date', width: 14 },
      { key: 'department_code', header: 'Dept', width: 10 },
      { key: 'class_name', header: 'Class', width: 18 },
      { key: 'section', header: 'Sec', width: 6 },
      { key: 'subject_code', header: 'Subject', width: 12 },
      { key: 'period_no', header: 'Period', width: 8 },
      { key: 'total_marked', header: 'Marked', width: 8 },
      { key: 'present', header: 'Present', width: 8 },
      { key: 'absent', header: 'Absent', width: 8 },
      { key: 'on_leave', header: 'On Leave', width: 9 },
      { key: 'taken_by', header: 'Taken by', width: 20 },
      { key: 'status', header: 'Status', width: 10 },
    ],
    load: (f) =>
      q(
        `SELECT a.session_date::text, d.code AS department_code, c.name AS class_name, c.section,
                sub.code AS subject_code, a.period_no,
                (SELECT count(*)::int FROM student_attendance x WHERE x.session_id=a.id) AS total_marked,
                (SELECT count(*)::int FROM student_attendance x WHERE x.session_id=a.id AND x.status='present') AS present,
                (SELECT count(*)::int FROM student_attendance x WHERE x.session_id=a.id AND x.status='absent') AS absent,
                (SELECT count(*)::int FROM student_attendance x WHERE x.session_id=a.id AND x.status='leave') AS on_leave,
                u.full_name AS taken_by, a.status
           FROM attendance_sessions a
           JOIN departments d ON d.id=a.department_id
           LEFT JOIN classes c ON c.id=a.class_id LEFT JOIN subjects sub ON sub.id=a.subject_id
           JOIN users u ON u.id=a.taken_by_user_id
          WHERE a.kind='student' AND a.session_date BETWEEN $1 AND $2
            AND ($3::int IS NULL OR a.department_id=$3) AND ($4::int IS NULL OR a.class_id=$4)
            AND ($5::int IS NULL OR a.subject_id=$5)
          ORDER BY a.session_date DESC, a.period_no`,
        [f.from, f.to, f.dept, f.classId, f.subjectId],
      ),
  },
  student_wise: {
    title: 'Student-wise attendance',
    columns: [
      { key: 'roll_no', header: 'Roll No', width: 12 },
      { key: 'full_name', header: 'Student', width: 24 },
      { key: 'department_code', header: 'Dept', width: 10 },
      { key: 'class_name', header: 'Class', width: 18 },
      { key: 'total', header: 'Total', width: 8 },
      { key: 'present', header: 'Present', width: 8 },
      { key: 'absent', header: 'Absent', width: 8 },
      { key: 'leave', header: 'Leave', width: 8 },
      { key: 'percentage', header: '%', width: 8 },
    ],
    load: (f) =>
      q(
        `SELECT s.roll_no, s.full_name, d.code AS department_code, c.name AS class_name,
                count(sa.id)::int AS total,
                sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS present,
                sum(CASE WHEN sa.status='absent' THEN 1 ELSE 0 END)::int AS absent,
                sum(CASE WHEN sa.status='leave' THEN 1 ELSE 0 END)::int AS leave,
                ROUND(100.0*sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)/GREATEST(count(sa.id),1),1) AS percentage
           FROM students s
           JOIN departments d ON d.id=s.department_id JOIN classes c ON c.id=s.class_id
           LEFT JOIN student_attendance sa ON sa.student_id=s.id
           LEFT JOIN attendance_sessions a ON a.id=sa.session_id AND a.session_date BETWEEN $1 AND $2
          WHERE s.active AND ($3::int IS NULL OR s.department_id=$3) AND ($4::int IS NULL OR s.class_id=$4)
          GROUP BY s.id, s.roll_no, s.full_name, d.code, c.name
          ORDER BY s.roll_no`,
        [f.from, f.to, f.dept, f.classId],
      ),
  },
  subject_wise: {
    title: 'Subject-wise attendance percentage',
    columns: [
      { key: 'roll_no', header: 'Roll No', width: 12 },
      { key: 'full_name', header: 'Student', width: 24 },
      { key: 'subject_code', header: 'Subject', width: 12 },
      { key: 'held', header: 'Held', width: 8 },
      { key: 'attended', header: 'Attended', width: 10 },
      { key: 'percentage', header: '%', width: 8 },
    ],
    load: (f) =>
      q(
        `SELECT s.roll_no, s.full_name, sub.code AS subject_code,
                count(sa.id)::int AS held,
                sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS attended,
                ROUND(100.0*sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)/GREATEST(count(sa.id),1),1) AS percentage
           FROM student_attendance sa
           JOIN attendance_sessions a ON a.id=sa.session_id AND a.session_date BETWEEN $1 AND $2
           JOIN students s ON s.id=sa.student_id JOIN subjects sub ON sub.id=a.subject_id
          WHERE ($3::int IS NULL OR a.department_id=$3) AND ($4::int IS NULL OR a.class_id=$4)
            AND ($5::int IS NULL OR a.subject_id=$5)
          GROUP BY s.id, s.roll_no, s.full_name, sub.code ORDER BY s.roll_no, sub.code`,
        [f.from, f.to, f.dept, f.classId, f.subjectId],
      ),
  },
  department_student: {
    title: 'Department-wise student attendance',
    columns: [
      { key: 'department_code', header: 'Dept', width: 10 },
      { key: 'students', header: 'Students', width: 10 },
      { key: 'total', header: 'Records', width: 10 },
      { key: 'present', header: 'Present', width: 10 },
      { key: 'absent', header: 'Absent', width: 10 },
      { key: 'percentage', header: '%', width: 8 },
    ],
    load: (f) =>
      q(
        `SELECT d.code AS department_code,
                (SELECT count(*)::int FROM students s WHERE s.department_id=d.id AND s.active) AS students,
                count(sa.id)::int AS total,
                sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS present,
                sum(CASE WHEN sa.status='absent' THEN 1 ELSE 0 END)::int AS absent,
                ROUND(100.0*sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)/GREATEST(count(sa.id),1),1) AS percentage
           FROM departments d
           LEFT JOIN student_attendance sa ON sa.student_id IN (SELECT id FROM students WHERE department_id=d.id)
           LEFT JOIN attendance_sessions a ON a.id=sa.session_id AND a.session_date BETWEEN $1 AND $2
          WHERE ($3::int IS NULL OR d.id=$3)
          GROUP BY d.id, d.code ORDER BY d.code`,
        [f.from, f.to, f.dept],
      ),
  },
  department_staff: {
    title: 'Department-wise staff attendance',
    columns: [
      { key: 'department_code', header: 'Dept', width: 10 },
      { key: 'staff', header: 'Staff', width: 8 },
      { key: 'total', header: 'Records', width: 10 },
      { key: 'present', header: 'Present', width: 10 },
      { key: 'absent', header: 'Absent', width: 10 },
      { key: 'leave', header: 'Leave', width: 8 },
      { key: 'half_day', header: 'Half Day', width: 10 },
      { key: 'percentage', header: '%', width: 8 },
    ],
    load: (f) =>
      q(
        `SELECT d.code AS department_code,
                (SELECT count(*)::int FROM staff s WHERE s.department_id=d.id AND s.employment_status='active') AS staff,
                count(sa.id)::int AS total,
                sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS present,
                sum(CASE WHEN sa.status='absent' THEN 1 ELSE 0 END)::int AS absent,
                sum(CASE WHEN sa.status='leave' THEN 1 ELSE 0 END)::int AS leave,
                sum(CASE WHEN sa.status='half_day' THEN 1 ELSE 0 END)::int AS half_day,
                ROUND(100.0*sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)/GREATEST(count(sa.id),1),1) AS percentage
           FROM departments d
           LEFT JOIN staff_attendance sa ON sa.staff_id IN (SELECT id FROM staff WHERE department_id=d.id)
           LEFT JOIN attendance_sessions a ON a.id=sa.session_id AND a.session_date BETWEEN $1 AND $2
          WHERE ($3::int IS NULL OR d.id=$3)
          GROUP BY d.id, d.code ORDER BY d.code`,
        [f.from, f.to, f.dept],
      ),
  },
  monthly_staff: {
    title: 'Monthly staff attendance',
    columns: [
      { key: 'staff_code', header: 'Code', width: 10 },
      { key: 'full_name', header: 'Staff', width: 24 },
      { key: 'designation', header: 'Designation', width: 20 },
      { key: 'department_code', header: 'Dept', width: 10 },
      { key: 'month', header: 'Month', width: 10 },
      { key: 'present', header: 'Present', width: 10 },
      { key: 'absent', header: 'Absent', width: 8 },
      { key: 'leave', header: 'Leave', width: 8 },
      { key: 'half_day', header: 'Half Day', width: 10 },
      { key: 'percentage', header: '%', width: 8 },
    ],
    load: (f) =>
      q(
        `SELECT sf.staff_code, sf.full_name, sf.designation, d.code AS department_code,
                to_char(a.session_date,'YYYY-MM') AS month,
                sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS present,
                sum(CASE WHEN sa.status='absent' THEN 1 ELSE 0 END)::int AS absent,
                sum(CASE WHEN sa.status='leave' THEN 1 ELSE 0 END)::int AS leave,
                sum(CASE WHEN sa.status='half_day' THEN 1 ELSE 0 END)::int AS half_day,
                ROUND(100.0*sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)/GREATEST(count(sa.id),1),1) AS percentage
           FROM staff_attendance sa JOIN staff sf ON sf.id=sa.staff_id
           JOIN departments d ON d.id=sf.department_id
           JOIN attendance_sessions a ON a.id=sa.session_id AND a.session_date BETWEEN $1 AND $2
          WHERE ($3::int IS NULL OR sf.department_id=$3) AND ($4::int IS NULL OR sf.id=$4)
          GROUP BY sf.id, sf.staff_code, sf.full_name, sf.designation, d.code, month
          ORDER BY month DESC, sf.full_name`,
        [f.from, f.to, f.dept, f.staffId],
      ),
  },
  absent_students: {
    title: 'Absent student list',
    columns: [
      { key: 'session_date', header: 'Date', width: 12 },
      { key: 'roll_no', header: 'Roll No', width: 12 },
      { key: 'full_name', header: 'Student', width: 24 },
      { key: 'class_name', header: 'Class', width: 18 },
      { key: 'subject_code', header: 'Subject', width: 12 },
      { key: 'period_no', header: 'Period', width: 8 },
      { key: 'guardian_phone', header: 'Guardian phone', width: 18 },
    ],
    load: (f) =>
      q(
        `SELECT a.session_date::text, s.roll_no, s.full_name, c.name AS class_name,
                sub.code AS subject_code, a.period_no, s.guardian_phone
           FROM student_attendance sa
           JOIN attendance_sessions a ON a.id=sa.session_id AND a.session_date BETWEEN $1 AND $2
           JOIN students s ON s.id=sa.student_id JOIN classes c ON c.id=s.class_id
           LEFT JOIN subjects sub ON sub.id=a.subject_id
          WHERE sa.status='absent' AND ($3::int IS NULL OR a.department_id=$3)
            AND ($4::int IS NULL OR a.class_id=$4)
          ORDER BY a.session_date DESC, s.roll_no`,
        [f.from, f.to, f.dept, f.classId],
      ),
  },
  weekly_summary: {
    title: 'Weekly class and student attendance summary',
    columns: [
      { key: 'week_start', header: 'Week starting', width: 14 },
      { key: 'department_code', header: 'Dept', width: 10 },
      { key: 'class_name', header: 'Class', width: 18 },
      { key: 'section', header: 'Section', width: 8 },
      { key: 'classes_conducted', header: 'Classes conducted', width: 16 },
      { key: 'student_records', header: 'Student records', width: 14 },
      { key: 'present', header: 'Present', width: 10 },
      { key: 'absent', header: 'Absent', width: 10 },
      { key: 'on_leave', header: 'On leave', width: 10 },
      { key: 'percentage', header: 'Attendance %', width: 13 },
    ],
    load: (f) =>
      q(
        `SELECT to_char(date_trunc('week', a.session_date), 'YYYY-MM-DD') AS week_start,
                d.code AS department_code, c.name AS class_name, c.section,
                count(DISTINCT a.id)::int AS classes_conducted,
                count(sa.id)::int AS student_records,
                sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS present,
                sum(CASE WHEN sa.status='absent' THEN 1 ELSE 0 END)::int AS absent,
                sum(CASE WHEN sa.status='leave' THEN 1 ELSE 0 END)::int AS on_leave,
                ROUND(100.0 * sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)
                      / GREATEST(count(sa.id), 1), 1) AS percentage
           FROM attendance_sessions a
           JOIN departments d ON d.id=a.department_id
           JOIN classes c ON c.id=a.class_id
           LEFT JOIN student_attendance sa ON sa.session_id=a.id
          WHERE a.kind='student' AND a.session_date BETWEEN $1 AND $2
            AND ($3::int IS NULL OR a.department_id=$3)
            AND ($4::int IS NULL OR a.class_id=$4)
          GROUP BY date_trunc('week', a.session_date), d.code, c.name, c.section
          ORDER BY date_trunc('week', a.session_date) DESC, d.code, c.name, c.section`,
        [f.from, f.to, f.dept, f.classId],
      ),
  },
  low_attendance: {
    title: 'Low attendance students',
    columns: [
      { key: 'roll_no', header: 'Roll No', width: 12 },
      { key: 'full_name', header: 'Student', width: 24 },
      { key: 'department_code', header: 'Dept', width: 10 },
      { key: 'class_name', header: 'Class', width: 18 },
      { key: 'held', header: 'Held', width: 8 },
      { key: 'attended', header: 'Attended', width: 10 },
      { key: 'percentage', header: '%', width: 8 },
      { key: 'guardian_phone', header: 'Guardian phone', width: 18 },
    ],
    load: (f) =>
      q(
        `SELECT * FROM (
          SELECT s.roll_no, s.full_name, d.code AS department_code, c.name AS class_name, s.guardian_phone,
                 count(sa.id)::int AS held,
                 sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)::int AS attended,
                 ROUND(100.0*sum(CASE WHEN sa.status='present' THEN 1 ELSE 0 END)/GREATEST(count(sa.id),1),1) AS percentage
            FROM student_attendance sa
            JOIN attendance_sessions a ON a.id=sa.session_id AND a.session_date BETWEEN $1 AND $2
            JOIN students s ON s.id=sa.student_id
            JOIN departments d ON d.id=s.department_id JOIN classes c ON c.id=s.class_id
           WHERE ($3::int IS NULL OR s.department_id=$3) AND ($4::int IS NULL OR s.class_id=$4)
           GROUP BY s.id, s.roll_no, s.full_name, d.code, c.name, s.guardian_phone
         ) t WHERE t.percentage < $5 ORDER BY t.percentage, t.roll_no`,
        [f.from, f.to, f.dept, f.classId, f.threshold],
      ),
  },
  sms_delivery: {
    title: 'SMS delivery report',
    columns: [
      { key: 'created_at', header: 'Queued at', width: 20 },
      { key: 'audience', header: 'Audience', width: 10 },
      { key: 'to_phone', header: 'To', width: 16 },
      { key: 'recipient_kind', header: 'Recipient', width: 12 },
      { key: 'status_value', header: 'Attendance', width: 12 },
      { key: 'status', header: 'SMS status', width: 12 },
      { key: 'provider', header: 'Provider', width: 10 },
      { key: 'attempts', header: 'Attempts', width: 10 },
      { key: 'last_error', header: 'Last error', width: 40 },
    ],
    load: (f) =>
      q(
        `SELECT to_char(o.created_at,'YYYY-MM-DD HH24:MI') AS created_at, o.audience, o.to_phone,
                o.recipient_kind, o.status_value, o.status, o.provider, o.attempts, o.last_error
           FROM sms_outbox o
          WHERE o.created_at::date BETWEEN $1::date AND $2::date
            AND ($3::int IS NULL OR o.department_id=$3)
          ORDER BY o.created_at DESC LIMIT 5000`,
        [f.from, f.to, f.dept],
      ),
  },
  corrections: {
    title: 'Attendance correction history',
    columns: [
      { key: 'created_at', header: 'Requested', width: 20 },
      { key: 'session_date', header: 'Session date', width: 12 },
      { key: 'department_code', header: 'Dept', width: 10 },
      { key: 'person_code', header: 'Roll/Code', width: 12 },
      { key: 'person_name', header: 'Name', width: 22 },
      { key: 'old_status', header: 'From', width: 10 },
      { key: 'new_status', header: 'To', width: 10 },
      { key: 'reason', header: 'Reason', width: 32 },
      { key: 'status', header: 'Decision', width: 10 },
      { key: 'requested_by_name', header: 'Requested by', width: 18 },
      { key: 'decided_by_name', header: 'Decided by', width: 18 },
    ],
    load: (f) =>
      q(
        `SELECT to_char(c.created_at,'YYYY-MM-DD HH24:MI') AS created_at, a.session_date::text, d.code AS department_code,
                COALESCE(st.roll_no, sf.staff_code) AS person_code, COALESCE(st.full_name, sf.full_name) AS person_name,
                c.old_status, c.new_status, c.reason, c.status,
                ru.full_name AS requested_by_name, du.full_name AS decided_by_name
           FROM attendance_corrections c
           JOIN attendance_sessions a ON a.id=c.session_id JOIN departments d ON d.id=a.department_id
           LEFT JOIN students st ON st.id=c.student_id LEFT JOIN staff sf ON sf.id=c.staff_id
           JOIN users ru ON ru.id=c.requested_by LEFT JOIN users du ON du.id=c.decided_by
          WHERE a.session_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR a.department_id=$3)
          ORDER BY c.created_at DESC`,
        [f.from, f.to, f.dept],
      ),
  },
};

reportsRouter.get(
  '/:key',
  ah(async (req, res) => {
    const key = String(req.params.key);
    const def = REPORTS[key];
    if (!def) throw badRequest('Unknown report.');
    if (req.user!.role === 'student' || req.user!.role === 'staff') throw forbidden('Reports are not available for this role.');
    const filters = parseFilters(req as never);
    const rows = await def.load(filters);
    const format = String(req.query.format ?? 'json').toLowerCase();
    const stamp = todayISO();

    if (format === 'csv') {
      const header = def.columns.map((c) => `"${c.header}"`).join(',');
      const lines = rows.map((r) =>
        def.columns
          .map((c) => {
            const v = r[c.key];
            if (v == null) return '';
            const s = String(v).replace(/"/g, '""');
            return `"${s}"`;
          })
          .join(','),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="attendease-${key}-${stamp}.csv"`);
      return res.send([header, ...lines].join('\r\n'));
    }

    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'AttendEase';
      const ws = wb.addWorksheet(def.title.slice(0, 30));
      ws.columns = def.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 14 }));
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12294F' } };
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      for (const r of rows) ws.addRow(r);
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="attendease-${key}-${stamp}.xlsx"`);
      const buf = await wb.xlsx.writeBuffer();
      return res.send(Buffer.from(buf));
    }

    if (format === 'pdf') {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="attendease-${key}-${stamp}.pdf"`);
      doc.pipe(res);
      doc.fontSize(15).fillColor('#12294F').text(config.college.name, { align: 'left' });
      doc.fontSize(10).fillColor('#475467').text(`${def.title}  •  ${prettyDate(filters.from)} to ${prettyDate(filters.to)}`);
      doc.moveDown(0.6);
      const cols = def.columns.slice(0, 9);
      const usable = doc.page.width - 56;
      const colW = usable / cols.length;
      let y = doc.y;
      doc.fontSize(8).fillColor('#12294F');
      cols.forEach((c, i) => doc.text(c.header, 28 + i * colW, y, { width: colW - 3, ellipsis: true }));
      y += 13;
      doc.moveTo(28, y - 3).lineTo(doc.page.width - 28, y - 3).strokeColor('#D0D5DD').stroke();
      doc.fillColor('#101828');
      for (const r of rows) {
        if (y > doc.page.height - 50) {
          doc.addPage();
          y = 40;
        }
        cols.forEach((c, i) => {
          const v = r[c.key];
          doc.text(v == null ? '-' : String(v).slice(0, 40), 28 + i * colW, y, { width: colW - 3, ellipsis: true });
        });
        y += 12;
      }
      doc.fontSize(7).fillColor('#667085').text(`Generated ${new Date().toISOString()} • ${rows.length} rows • AttendEase`, 28, doc.page.height - 34);
      doc.end();
      return;
    }

    const totals = await one<{ n: number }>('SELECT 1 AS n');
    void totals;
    res.json({ key, title: def.title, columns: def.columns, rows, count: rows.length });
  }),
);

export const REPORT_LIST = Object.entries(REPORTS).map(([key, def]) => ({ key, title: def.title }));
