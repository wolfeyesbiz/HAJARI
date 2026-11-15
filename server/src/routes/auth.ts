import { Router } from 'express';
import { z } from 'zod';
import { one, q } from '../db/index.js';
import { hashPassword, newSessionToken, verifyPassword } from '../lib/crypto.js';
import { ah, badRequest, unauthorized } from '../lib/errors.js';
import { attachUser, cookieOptions, createSession, destroySession, requireAuth, SESSION_COOKIE } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { smsConfigured, smsDriverLabel } from '../config.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().min(3).max(190),
  password: z.string().min(1).max(200),
});

authRouter.post(
  '/login',
  ah(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Enter your email and password.');
    const { email, password } = parsed.data;

    const user = await one<{
      id: number;
      full_name: string;
      email: string;
      password_hash: string;
      role: string;
      status: string;
      department_id: number | null;
    }>('SELECT id, full_name, email, password_hash, role, status, department_id FROM users WHERE lower(email) = lower($1)', [
      email,
    ]);

    // Same generic message for unknown user and wrong password (no account enumeration).
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw unauthorized('Incorrect email or password.');
    }
    if (user.status !== 'active') throw unauthorized('This account has been deactivated. Contact the administrator.');

    const token = newSessionToken();
    await createSession(Number(user.id), token, req);
    await q('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    res.cookie(SESSION_COOKIE, token, cookieOptions());
    await audit({ actorUserId: Number(user.id), action: 'auth.login', entity: 'users', entityId: user.id, req });
    res.json({ ok: true, user: { id: Number(user.id), full_name: user.full_name, role: user.role } });
  }),
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await destroySession(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  attachUser,
  requireAuth,
  ah(async (req, res) => {
    const u = req.user!;
    const extra: Record<string, unknown> = {};
    if (u.role === 'student' && u.student_id) {
      extra.student = await one(
        `SELECT s.roll_no, s.semester, s.section, c.name AS class_name, d.code AS department_code
           FROM students s JOIN classes c ON c.id = s.class_id JOIN departments d ON d.id = s.department_id
          WHERE s.id = $1`,
        [u.student_id],
      );
    }
    if (u.role === 'staff' && u.staff_id) {
      extra.staff = await one('SELECT staff_code, designation, employment_type FROM staff WHERE id = $1', [u.staff_id]);
    }
    if (u.role === 'teacher') {
      extra.assignments = await q(
        `SELECT ta.id, ta.class_id, c.name AS class_name, c.semester, c.section,
                ta.subject_id, sub.code AS subject_code, sub.name AS subject_name,
                ta.department_id, d.code AS department_code, d.name AS department_name
           FROM teacher_assignments ta
           JOIN classes c ON c.id = ta.class_id
           JOIN subjects sub ON sub.id = ta.subject_id
           JOIN departments d ON d.id = ta.department_id
          WHERE ta.teacher_user_id = $1 AND ta.active = TRUE
          ORDER BY c.semester, c.section, sub.code`,
        [u.id],
      );
    }
    res.json({
      user: u,
      ...extra,
      system: { smsDriver: smsDriverLabel(), smsConfigured: smsConfigured() },
    });
  }),
);

const changePassword = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Use at least 8 characters.'),
});

authRouter.post(
  '/change-password',
  attachUser,
  requireAuth,
  ah(async (req, res) => {
    const parsed = changePassword.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid password.');
    const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!row || !verifyPassword(parsed.data.currentPassword, row.password_hash)) {
      throw unauthorized('Your current password is incorrect.');
    }
    await q('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user!.id, hashPassword(parsed.data.newPassword)]);
    await audit({ actorUserId: req.user!.id, action: 'auth.password_changed', entity: 'users', entityId: req.user!.id, req });
    res.json({ ok: true });
  }),
);
