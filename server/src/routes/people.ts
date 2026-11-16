import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { q, one, tx } from '../db/index.js';
import { ah, badRequest, conflict, notFound } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { hashPassword } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';

export const peopleRouter = Router();
peopleRouter.use(requireAuth);

const studentCsvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');

/* ------------------------------- Students ------------------------------- */

peopleRouter.get(
  '/students',
  ah(async (req, res) => {
    const u = req.user!;
    const dept = u.role === 'admin' ? (req.query.department_id ? Number(req.query.department_id) : null) : u.department_id;
    const classId = req.query.class_id ? Number(req.query.class_id) : null;
    const search = (req.query.q as string | undefined)?.trim() ?? '';
    const rows = await q(
      `SELECT s.id, s.roll_no, s.full_name, s.email, s.phone, s.guardian_name, s.guardian_phone,
              s.semester, s.section, s.active, s.is_demo, s.class_id, c.name AS class_name,
              s.department_id, d.code AS department_code
         FROM students s
         JOIN classes c ON c.id = s.class_id
         JOIN departments d ON d.id = s.department_id
        WHERE ($1::int IS NULL OR s.department_id = $1)
          AND ($2::int IS NULL OR s.class_id = $2)
          AND ($3::text = '' OR s.full_name ILIKE '%' || $3 || '%' OR s.roll_no ILIKE '%' || $3 || '%')
        ORDER BY s.roll_no
        LIMIT 500`,
      [dept, classId, search],
    );
    res.json({ students: rows });
  }),
);

const studentSchema = z.object({
  roll_no: z.string().trim().min(2).max(30),
  full_name: z.string().trim().min(2).max(120),
  class_id: z.number().int().positive(),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  guardian_name: z.string().trim().max(120).optional().or(z.literal('')),
  guardian_phone: z.string().trim().max(20).optional().or(z.literal('')),
});

peopleRouter.post(
  '/students',
  requireRole('admin'),
  ah(async (req, res) => {
    const parsed = studentSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid student details.');
    const d = parsed.data;
    const cls = await one<{ department_id: number; semester: number; section: string }>(
      'SELECT department_id, semester, section FROM classes WHERE id = $1',
      [d.class_id],
    );
    if (!cls) throw notFound('Class not found.');
    const dup = await one('SELECT id FROM students WHERE upper(roll_no) = upper($1)', [d.roll_no]);
    if (dup) throw conflict(`Roll number ${d.roll_no} already exists.`);

    const student = await one<{ id: number }>(
      `INSERT INTO students (roll_no, full_name, email, phone, department_id, class_id, semester, section, guardian_name, guardian_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [d.roll_no, d.full_name, d.email || null, d.phone || null, cls.department_id, d.class_id, cls.semester, cls.section, d.guardian_name || null, d.guardian_phone || null],
    );

    if (d.guardian_phone) {
      await q('INSERT INTO parent_contacts (student_id, name, relation, phone) VALUES ($1,$2,$3,$4)', [
        student!.id,
        d.guardian_name || 'Guardian',
        'Guardian',
        d.guardian_phone,
      ]);
    }
    if (d.email) {
      await q(
        `INSERT INTO users (full_name, email, phone, password_hash, role, department_id)
         VALUES ($1,$2,$3,$4,'student',$5) ON CONFLICT (email) DO NOTHING`,
        [d.full_name, d.email, d.phone || null, hashPassword('Student@123'), cls.department_id],
      );
    }
    await audit({ actorUserId: req.user!.id, action: 'student.create', entity: 'students', entityId: student!.id, after: d, req });
    res.status(201).json({ id: Number(student!.id) });
  }),
);

peopleRouter.patch(
  '/students/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const parsed = studentSchema.partial().extend({ active: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid student update.');
    const before = await one('SELECT * FROM students WHERE id = $1', [id]);
    if (!before) throw notFound('Student not found.');
    const d = parsed.data;
    await q(
      `UPDATE students SET
         roll_no = COALESCE($2, roll_no),
         full_name = COALESCE($3, full_name),
         email = COALESCE($4, email),
         phone = COALESCE($5, phone),
         guardian_name = COALESCE($6, guardian_name),
         guardian_phone = COALESCE($7, guardian_phone),
         active = COALESCE($8, active)
       WHERE id = $1`,
      [id, d.roll_no ?? null, d.full_name ?? null, d.email || null, d.phone || null, d.guardian_name || null, d.guardian_phone || null, d.active ?? null],
    );
    const after = await one('SELECT * FROM students WHERE id = $1', [id]);
    await audit({ actorUserId: req.user!.id, action: 'student.update', entity: 'students', entityId: id, before, after, req });
    res.json({ ok: true, student: after });
  }),
);

const studentCsvRowSchema = z.object({
  roll_no: z.string().trim().min(2).max(30),
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  guardian_name: z.string().trim().max(120).optional().or(z.literal('')),
  guardian_phone: z.string().trim().max(20).optional().or(z.literal('')),
});

const studentCsvUploadMiddleware: RequestHandler = (req, res, next) => {
  studentCsvUpload(req, res, (err: unknown) => {
    if (err) return next(badRequest(err instanceof Error && err.message.includes('File too large') ? 'CSV must be 5 MB or smaller.' : 'Could not read the uploaded CSV.'));
    next();
  });
};

peopleRouter.post('/students/import-csv', requireRole('admin'), studentCsvUploadMiddleware, ah(async (req, res) => {
  if (!req.file) throw badRequest('Choose a CSV file to upload.');
  const classId = Number(req.body.class_id);
  if (!Number.isInteger(classId) || classId <= 0) throw badRequest('Choose a valid class for this import.');
  const cls = await one<{ department_id: number; semester: number; section: string }>(
    'SELECT department_id, semester, section FROM classes WHERE id=$1', [classId],
  );
  if (!cls) throw notFound('Class not found.');

  let csvRows: string[][];
  try {
    csvRows = parseCsv(req.file.buffer, { bom: true, skip_empty_lines: true, trim: true, max_record_size: 20_000 });
  } catch {
    throw badRequest('CSV formatting is invalid. Check that quoted fields are closed correctly.');
  }
  if (csvRows.length < 2) throw badRequest('CSV needs a header row and at least one student.');
  if (csvRows.length > 2001) throw badRequest('A CSV can contain at most 2,000 students per import.');

  const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/[\\s-]+/g, '_');
  const headers = csvRows[0].map(normalizeHeader);
  if (new Set(headers).size !== headers.length) throw badRequest('CSV contains duplicate column headers.');
  const findColumn = (...names: string[]) => headers.findIndex(header => names.includes(header));
  const columns = {
    roll_no: findColumn('roll_no', 'roll', 'usn', 'student_id'),
    full_name: findColumn('full_name', 'name', 'student_name'),
    email: findColumn('email'),
    phone: findColumn('phone', 'mobile'),
    guardian_name: findColumn('guardian_name', 'parent_name'),
    guardian_phone: findColumn('guardian_phone', 'parent_phone'),
  };
  if (columns.roll_no < 0 || columns.full_name < 0) {
    throw badRequest('CSV needs roll_no (or roll/USN) and full_name (or name) columns.');
  }

  const students = csvRows.slice(1).map((cells, rowIndex) => {
    const value = (column: number) => column < 0 ? '' : (cells[column] ?? '').trim();
    const parsed = studentCsvRowSchema.safeParse({
      roll_no: value(columns.roll_no), full_name: value(columns.full_name), email: value(columns.email),
      phone: value(columns.phone), guardian_name: value(columns.guardian_name), guardian_phone: value(columns.guardian_phone),
    });
    if (!parsed.success) throw badRequest(`CSV row ${rowIndex + 2}: ${parsed.error.issues[0]?.message ?? 'invalid student data.'}`);
    return parsed.data;
  });

  const rolls = students.map(student => student.roll_no.toUpperCase());
  if (new Set(rolls).size !== rolls.length) throw badRequest('CSV contains duplicate roll numbers.');
  const collisions = await q<{ roll_no: string }>(
    'SELECT roll_no FROM students WHERE upper(roll_no)=ANY($1::text[]) AND NOT (class_id=$2 AND is_demo)', [rolls, classId],
  );
  if (collisions.length) throw conflict(`Roll number ${collisions[0].roll_no} already exists.`);
  const demoCount = await one<{ count: number }>('SELECT count(*)::int AS count FROM students WHERE class_id=$1 AND is_demo=TRUE', [classId]);

  await tx(async t => {
    await t.q('DELETE FROM students WHERE class_id=$1 AND is_demo=TRUE', [classId]);
    for (const student of students) {
      await t.q(`INSERT INTO students (roll_no,full_name,email,phone,department_id,class_id,semester,section,guardian_name,guardian_phone,is_demo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE)`,
      [student.roll_no,student.full_name,student.email||null,student.phone||null,cls.department_id,classId,cls.semester,cls.section,student.guardian_name||null,student.guardian_phone||null]);
    }
  });
  await audit({ actorUserId: req.user!.id, action: 'student.import', entity: 'classes', entityId: classId, after: { imported: students.length, replaced_demo: Number(demoCount?.count ?? 0) }, req });
  res.status(201).json({ imported: students.length, replaced_demo: Number(demoCount?.count ?? 0) });
}));

/* --------------------------------- Staff -------------------------------- */

peopleRouter.get(
  '/staff',
  ah(async (req, res) => {
    const u = req.user!;
    const dept = u.role === 'admin' ? (req.query.department_id ? Number(req.query.department_id) : null) : u.department_id;
    const rows = await q(
      `SELECT sf.id, sf.staff_code, sf.full_name, sf.designation, sf.phone, sf.email,
              sf.employment_type, sf.employment_status, sf.is_demo, sf.department_id, d.code AS department_code,
              u.id AS user_id
         FROM staff sf JOIN departments d ON d.id = sf.department_id
         LEFT JOIN users u ON lower(u.email) = lower(sf.email)
        WHERE ($1::int IS NULL OR sf.department_id = $1)
        ORDER BY d.code, sf.employment_type, sf.full_name`,
      [dept],
    );
    res.json({ staff: rows });
  }),
);

const staffSchema = z.object({
  staff_code: z.string().trim().min(2).max(30),
  full_name: z.string().trim().min(2).max(120),
  designation: z.string().trim().min(2).max(80),
  department_id: z.number().int().positive(),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  email: z.string().trim().email().optional().or(z.literal('')),
  employment_type: z.enum(['teaching', 'non_teaching']).default('teaching'),
});

peopleRouter.post(
  '/staff',
  requireRole('admin'),
  ah(async (req, res) => {
    const parsed = staffSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid staff details.');
    const d = parsed.data;
    const dup = await one('SELECT id FROM staff WHERE upper(staff_code) = upper($1)', [d.staff_code]);
    if (dup) throw conflict(`Staff code ${d.staff_code} already exists.`);
    const staff = await one<{ id: number }>(
      `INSERT INTO staff (staff_code, full_name, designation, department_id, phone, email, employment_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [d.staff_code, d.full_name, d.designation, d.department_id, d.phone || null, d.email || null, d.employment_type],
    );
    let userId: number | null = null;
    if (d.email) {
      const u = await one<{ id: number }>(
        `INSERT INTO users (full_name, email, phone, password_hash, role, department_id)
         VALUES ($1,$2,$3,$4,'staff',$5) ON CONFLICT (email) DO NOTHING RETURNING id`,
        [d.full_name, d.email, d.phone || null, hashPassword('Staff@123'), d.department_id],
      );
      userId = u ? Number(u.id) : null;
    }
    await audit({ actorUserId: req.user!.id, action: 'staff.create', entity: 'staff', entityId: staff!.id, after: d, req });
    res.status(201).json({ id: Number(staff!.id), user_id: userId });
  }),
);

peopleRouter.patch(
  '/staff/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const parsed = z
      .object({
        full_name: z.string().trim().min(2).max(120).optional(),
        designation: z.string().trim().min(2).max(80).optional(),
        phone: z.string().trim().max(20).optional(),
        employment_status: z.enum(['active', 'inactive']).optional(),
        employment_type: z.enum(['teaching', 'non_teaching']).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid staff update.');
    const before = await one('SELECT * FROM staff WHERE id = $1', [id]);
    if (!before) throw notFound('Staff member not found.');
    const d = parsed.data;
    await q(
      `UPDATE staff SET full_name = COALESCE($2, full_name), designation = COALESCE($3, designation),
              phone = COALESCE($4, phone), employment_status = COALESCE($5, employment_status),
              employment_type = COALESCE($6, employment_type)
       WHERE id = $1`,
      [id, d.full_name ?? null, d.designation ?? null, d.phone ?? null, d.employment_status ?? null, d.employment_type ?? null],
    );
    const after = await one('SELECT * FROM staff WHERE id = $1', [id]);
    await audit({ actorUserId: req.user!.id, action: 'staff.update', entity: 'staff', entityId: id, before, after, req });
    res.json({ ok: true, staff: after });
  }),
);

/* --------------------------------- Users -------------------------------- */

peopleRouter.get(
  '/users',
  requireRole('admin'),
  ah(async (_req, res) => {
    const rows = await q(
      `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.status, u.last_login_at,
              u.department_id, d.code AS department_code
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
        ORDER BY u.role, u.full_name`,
    );
    res.json({ users: rows });
  }),
);

const userSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  password: z.string().min(8, 'Use at least 8 characters.'),
  role: z.enum(['admin', 'hod', 'teacher']),
  department_id: z.number().int().positive().nullable().optional(),
});

peopleRouter.post(
  '/users',
  requireRole('admin'),
  ah(async (req, res) => {
    const parsed = userSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid user details.');
    const d = parsed.data;
    const exists = await one('SELECT id FROM users WHERE lower(email) = lower($1)', [d.email]);
    if (exists) throw conflict('An account with that email already exists.');
    const row = await one<{ id: number }>(
      `INSERT INTO users (full_name, email, phone, password_hash, role, department_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [d.full_name, d.email, d.phone || null, hashPassword(d.password), d.role, d.department_id ?? null],
    );
    // A teacher account also gets a staff directory entry so their own staff attendance works.
    if (d.role === 'teacher' && d.department_id) {
      const code = `T${String(row!.id).padStart(3, '0')}`;
      await q(
        `INSERT INTO staff (staff_code, full_name, designation, department_id, phone, email, employment_type)
         VALUES ($1,$2,'Assistant Professor',$3,$4,$5,'teaching') ON CONFLICT (staff_code) DO NOTHING`,
        [code, d.full_name, d.department_id, d.phone || null, d.email],
      );
    }
    await audit({ actorUserId: req.user!.id, action: 'user.create', entity: 'users', entityId: row!.id, after: { ...d, password: '***' }, req });
    res.status(201).json({ id: Number(row!.id) });
  }),
);

peopleRouter.patch(
  '/users/:id/status',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const parsed = z.object({ status: z.enum(['active', 'inactive']) }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid status.');
    if (id === req.user!.id) throw conflict('You cannot deactivate your own account.');
    const before = await one('SELECT id, status FROM users WHERE id = $1', [id]);
    if (!before) throw notFound('User not found.');
    await q('UPDATE users SET status = $2 WHERE id = $1', [id, parsed.data.status]);
    if (parsed.data.status === 'inactive') {
      await q('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    await audit({ actorUserId: req.user!.id, action: 'user.status', entity: 'users', entityId: id, before, after: parsed.data, req });
    res.json({ ok: true });
  }),
);

peopleRouter.post(
  '/users/:id/reset-password',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const parsed = z.object({ password: z.string().min(8, 'Use at least 8 characters.') }).safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid password.');
    const target = await one('SELECT id FROM users WHERE id = $1', [id]);
    if (!target) throw notFound('User not found.');
    await q('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hashPassword(parsed.data.password)]);
    await q('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit({ actorUserId: req.user!.id, action: 'user.password_reset', entity: 'users', entityId: id, req });
    res.json({ ok: true });
  }),
);
