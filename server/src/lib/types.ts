export type Role = 'admin' | 'hod' | 'teacher' | 'student' | 'staff';

export interface SessionUser {
  id: number;
  full_name: string;
  email: string;
  phone: string | null;
  role: Role;
  department_id: number | null;
  department_code?: string | null;
  department_name?: string | null;
  student_id?: number | null;
  staff_id?: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export const isAdmin = (u: SessionUser) => u.role === 'admin';
export const isHod = (u: SessionUser) => u.role === 'hod';
export const isTeacher = (u: SessionUser) => u.role === 'teacher';

/** Admin sees everything; HOD is pinned to their department; teacher to assignments. */
export function scopeDepartmentId(user: SessionUser, requested?: number | null): number | null {
  if (isAdmin(user)) return requested ?? null;
  return user.department_id ?? null;
}

export function todayISO(): string {
  // College-local date (Asia/Kolkata) so "today's attendance" matches the wall clock.
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

export function isValidDate(yyyymmdd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return false;
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === yyyymmdd;
}

export function dayName(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
}

export function prettyDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const STATUS_LABEL: Record<string, string> = {
  present: 'Present',
  absent: 'Absent',
  leave: 'On Leave',
  half_day: 'Half Day',
};
