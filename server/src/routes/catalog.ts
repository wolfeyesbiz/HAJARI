import { Router } from 'express';
import { z } from 'zod';
import { one, q } from '../db/index.js';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';

export const departmentsRouter = Router();
departmentsRouter.use(requireAuth);

departmentsRouter.get(
  '/',
  ah(async (req, res) => {
    const rows = await q(
      `SELECT d.id, d.code, d.name, d.active,
              (SELECT count(*)::int FROM students s WHERE s.department_id = d.id AND s.active) AS students,
              (SELECT count(*)::int FROM staff sf WHERE sf.department_id = d.id AND sf.employment_status = 'active') AS staff,
              (SELECT count(*)::int FROM classes c WHERE c.department_id = d.id AND c.active) AS classes,
              (SELECT count(*)::int FROM attendance_sessions a
                WHERE a.department_id = d.id AND a.session_date = CURRENT_DATE) AS sessions_today
         FROM departments d
        WHERE ($1::boolean OR d.id = $2)
        ORDER BY d.code`,
      [req.user!.role === 'admin', req.user!.department_id],
    );
    res.json({ departments: rows });
  }),
);

const deptSchema = z.object({
  code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9&-]+$/, 'Use letters, numbers, & or - only.'),
  name: z.string().trim().min(3).max(120),
});

departmentsRouter.post(
  '/',
  requireRole('admin'),
  ah(async (req, res) => {
    const parsed = deptSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid department.');
    const code = parsed.data.code.toUpperCase();
    const exists = await one('SELECT id FROM departments WHERE upper(code) = $1', [code]);
    if (exists) throw conflict(`Department ${code} already exists.`);
    const row = await one<{ id: number }>(
      'INSERT INTO departments (code, name) VALUES ($1,$2) RETURNING id',
      [code, parsed.data.name],
    );
    await audit({ actorUserId: req.user!.id, action: 'department.create', entity: 'departments', entityId: row!.id, after: { code, name: parsed.data.name }, req });
    res.status(201).json({ id: Number(row!.id) });
  }),
);

departmentsRouter.patch(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    const parsed = z.object({ name: z.string().trim().min(3).max(120).optional(), active: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid update.');
    const before = await one('SELECT id, code, name, active FROM departments WHERE id = $1', [id]);
    if (!before) throw notFound('Department not found.');
    await q('UPDATE departments SET name = COALESCE($2, name), active = COALESCE($3, active) WHERE id = $1', [
      id,
      parsed.data.name ?? null,
      parsed.data.active ?? null,
    ]);
    const after = await one('SELECT id, code, name, active FROM departments WHERE id = $1', [id]);
    await audit({ actorUserId: req.user!.id, action: 'department.update', entity: 'departments', entityId: id, before, after, req });
    res.json({ ok: true, department: after });
  }),
);

export const classesRouter = Router();
classesRouter.use(requireAuth);

classesRouter.get(
  '/',
  ah(async (req, res) => {
    const deptFilter = req.user!.role === 'admin' ? null : req.user!.department_id;
    const rows = await q(
      `SELECT c.id, c.name, c.semester, c.section, c.academic_year, c.cycle, c.active,
              c.department_id, d.code AS department_code, d.name AS department_name,
              (SELECT count(*)::int FROM students s WHERE s.class_id = c.id AND s.active) AS student_count
         FROM classes c JOIN departments d ON d.id = c.department_id
        WHERE ($1::int IS NULL OR c.department_id = $1)
        ORDER BY d.code, c.semester, c.section`,
      [deptFilter],
    );
    res.json({ classes: rows });
  }),
);

classesRouter.post(
  '/',
  requireRole('admin'),
  ah(async (req, res) => {
    const parsed = z
      .object({
        department_id: z.number().int().positive(),
        semester: z.number().int().min(1).max(8),
        section: z.string().trim().min(1).max(5),
        academic_year: z.string().trim().min(4).max(9).optional(),
        cycle: z.enum(['standard','chemistry','physics']).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid class details.');
    const dept = await one<{ code: string }>('SELECT code FROM departments WHERE id = $1', [parsed.data.department_id]);
    if (!dept) throw notFound('Department not found.');
    const name = `${dept.code} Sem ${parsed.data.semester}`;
    const row = await one<{ id: number }>(
      `INSERT INTO classes (name, department_id, semester, section, academic_year, cycle)
       VALUES ($1,$2,$3,$4,COALESCE($5,'2026-27'),COALESCE($6,'standard')) RETURNING id`,
      [name, parsed.data.department_id, parsed.data.semester, parsed.data.section.toUpperCase(), parsed.data.academic_year ?? null, parsed.data.cycle ?? null],
    );
    await audit({ actorUserId: req.user!.id, action: 'class.create', entity: 'classes', entityId: row!.id, after: req.body, req });
    res.status(201).json({ id: Number(row!.id) });
  }),
);

export const subjectsRouter = Router();
subjectsRouter.use(requireAuth);

subjectsRouter.get(
  '/',
  ah(async (req, res) => {
    const deptFilter = req.user!.role === 'admin' ? null : req.user!.department_id;
    const rows = await q(
      `SELECT s.id, s.code, s.name, s.semester, s.credits, s.department_id, d.code AS department_code
         FROM subjects s JOIN departments d ON d.id = s.department_id
        WHERE ($1::int IS NULL OR s.department_id = $1) AND s.active
        ORDER BY d.code, s.semester, s.code`,
      [deptFilter],
    );
    res.json({ subjects: rows });
  }),
);

export const periodsRouter = Router();
periodsRouter.use(requireAuth);
periodsRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json({ periods: await q('SELECT period_no, label, start_time, end_time FROM periods ORDER BY period_no') });
  }),
);

export const assignmentsRouter = Router();
assignmentsRouter.use(requireAuth);

assignmentsRouter.get(
  '/',
  ah(async (req, res) => {
    const teacherId = req.query.teacher_id ? Number(req.query.teacher_id) : null;
    if (teacherId && req.user!.role === 'teacher' && teacherId !== req.user!.id) throw forbidden();
    const deptFilter = req.user!.role === 'admin' ? null : req.user!.department_id;
    const rows = await q(
      `SELECT ta.id, ta.teacher_user_id, u.full_name AS teacher_name,
              ta.class_id, c.name AS class_name, c.semester, c.section,
              ta.subject_id, sub.code AS subject_code, sub.name AS subject_name,
              ta.department_id, d.code AS department_code
         FROM teacher_assignments ta
         JOIN users u ON u.id = ta.teacher_user_id
         JOIN classes c ON c.id = ta.class_id
         JOIN subjects sub ON sub.id = ta.subject_id
         JOIN departments d ON d.id = ta.department_id
        WHERE ta.active = TRUE
          AND ($1::int IS NULL OR ta.department_id = $1)
          AND ($2::int IS NULL OR ta.teacher_user_id = $2)
        ORDER BY d.code, c.semester, c.section, sub.code`,
      [deptFilter, teacherId],
    );
    res.json({ assignments: rows });
  }),
);

assignmentsRouter.post(
  '/',
  requireRole('admin'),
  ah(async (req, res) => {
    const parsed = z
      .object({
        teacher_user_id: z.number().int().positive(),
        class_id: z.number().int().positive(),
        subject_id: z.number().int().positive(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('Select a teacher, class and subject.');
    const cls = await one<{ department_id: number }>('SELECT department_id FROM classes WHERE id = $1', [parsed.data.class_id]);
    if (!cls) throw notFound('Class not found.');
    try {
      const row = await one<{ id: number }>(
        `INSERT INTO teacher_assignments (teacher_user_id, department_id, class_id, subject_id)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [parsed.data.teacher_user_id, cls.department_id, parsed.data.class_id, parsed.data.subject_id],
      );
      await audit({ actorUserId: req.user!.id, action: 'assignment.create', entity: 'teacher_assignments', entityId: row!.id, after: req.body, req });
      res.status(201).json({ id: Number(row!.id) });
    } catch {
      throw conflict('That teacher is already assigned to this class and subject.');
    }
  }),
);

assignmentsRouter.delete(
  '/:id',
  requireRole('admin'),
  ah(async (req, res) => {
    const id = Number(req.params.id);
    await q('UPDATE teacher_assignments SET active = FALSE WHERE id = $1', [id]);
    await audit({ actorUserId: req.user!.id, action: 'assignment.deactivate', entity: 'teacher_assignments', entityId: id, req });
    res.json({ ok: true });
  }),
);
