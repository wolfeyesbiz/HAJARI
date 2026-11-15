
import type { NextFunction, Request, Response } from 'express';
import { one, q } from '../db/index.js';
import { config } from '../config.js';
import { sha256 } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Role, SessionUser } from '../lib/types.js';

export const SESSION_COOKIE = 'ae_session';

interface AuthRow {
  session_id: number;
  user_id: number;
  full_name: string;
  email: string;
  phone: string | null;
  role: Role;
  department_id: number | null;
  department_code: string | null;
  department_name: string | null;
  student_id: number | null;
  staff_id: number | null;
}

export async function createSession(
  userId: number,
  token: string,
  req: Request,
): Promise<void> {
  await q(
    `INSERT INTO auth_sessions (user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)`,
    [
      userId,
      sha256(token),
      req.ip ?? null,
      req.get('user-agent') ?? null,
      String(config.sessionTtlHours),
    ],
  );
}

export async function destroySession(token: string): Promise<void> {
  await q(
    'UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1',
    [sha256(token)],
  );
}

/**
 * Cookie settings for local development and HTTPS deployments.
 * Set COOKIE_SECURE=1 when using HTTPS in production.
 */
export function cookieOptions() {
  const secureCookies = config.cookieSecure;

  return {
    httpOnly: true,
    sameSite: secureCookies ? ('none' as const) : ('lax' as const),
    secure: secureCookies,
    path: '/',
    maxAge: config.sessionTtlHours * 60 * 60 * 1000,
  };
}

/** Attaches req.user for a valid, unexpired, unrevoked session. */
export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];

    if (!token) {
      return next();
    }

    const row = await one<AuthRow>(
      `SELECT s.id AS session_id, u.id AS user_id, u.full_name, u.email, u.phone, u.role,
              u.department_id, d.code AS department_code, d.name AS department_name,
              st.id AS student_id, sf.id AS staff_id
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id AND u.status = 'active'
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN students st ON lower(st.email) = lower(u.email)
         LEFT JOIN staff sf ON lower(sf.email) = lower(u.email)
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()`,
      [sha256(token)],
    );

    if (row) {
      req.user = {
        id: Number(row.user_id),
        full_name: row.full_name,
        email: row.email,
        phone: row.phone,
        role: row.role,
        department_id:
          row.department_id != null ? Number(row.department_id) : null,
        department_code: row.department_code,
        department_name: row.department_name,
        student_id:
          row.student_id != null ? Number(row.student_id) : null,
        staff_id: row.staff_id != null ? Number(row.staff_id) : null,
      };
    }

    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    return next(unauthorized());
  }

  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(unauthorized());
    }

    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action is limited to: ${roles.join(', ')}.`));
    }

    next();
  };
}

export function hasPermission(role: Role, permission: string): boolean {
  const map: Record<Role, string[]> = {
    admin: ['*'],
    hod: [
      'attendance.view.department',
      'attendance.mark.department',
      'reports.view.department',
      'corrections.decide',
      'students.view.department',
    ],
    teacher: [
      'attendance.mark.assigned',
      'attendance.view.assigned',
      'attendance.mark.self',
      'corrections.request',
      'reports.view.assigned',
    ],
    student: ['attendance.view.self', 'notifications.view.self'],
    staff: ['attendance.view.self', 'notifications.view.self'],
  };

  const list = map[role] ?? [];
  return list.includes('*') || list.includes(permission);
}

/**
 * Whether this user may mark/take attendance for a given class + subject.
 * Enforced on the server for every mutation — the UI is never the only guard.
 */
export async function canMarkStudentAttendance(
  user: SessionUser,
  classId: number,
  subjectId: number,
): Promise<boolean> {
  if (user.role === 'admin') {
    return true;
  }

  const cls = await one<{ department_id: number }>(
    'SELECT department_id FROM classes WHERE id = $1',
    [classId],
  );

  if (!cls) {
    return false;
  }

  if (user.role === 'hod') {
    return Number(cls.department_id) === user.department_id;
  }

  if (user.role !== 'teacher') {
    return false;
  }

  const assignment = await one<{ id: number }>(
    `SELECT id FROM teacher_assignments
      WHERE teacher_user_id = $1
        AND class_id = $2
        AND subject_id = $3
        AND active = TRUE`,
    [user.id, classId, subjectId],
  );

  return Boolean(assignment);
}

export async function canMarkStaffAttendance(
  user: SessionUser,
  departmentId: number,
): Promise<boolean> {
  if (user.role === 'admin') {
    return true;
  }

  if (user.role === 'hod') {
    return user.department_id === departmentId;
  }

  return false;
}
