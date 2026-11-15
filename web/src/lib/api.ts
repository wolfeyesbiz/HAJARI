import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------- API client ------------------------------ */

const API_BASE = import.meta.env.VITE_API_BASE?.replace(/\/$/, '') ?? '';

function getApiBase(): string {
  return API_BASE;
}

function getApiCredentials(): RequestCredentials {
  return getApiBase() ? 'include' : 'same-origin';
}

function getApiHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  return result;
}

export async function api<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const apiBase = getApiBase();

  const opts: RequestInit = {
    ...init,
    headers: getApiHeaders(init?.headers),
    credentials: apiBase ? 'include' : 'same-origin',
  };

  if (init?.json !== undefined) {
    opts.method = init.method ?? 'POST';

    const headers = new Headers(opts.headers);
    headers.set('Content-Type', 'application/json');
    opts.headers = headers;

    opts.body = JSON.stringify(init.json);
  }

  const res = await fetch(`${apiBase}/api${path}`, opts);
  const text = await res.text();

  let data: any = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `The API returned HTML or invalid JSON (HTTP ${res.status}). Check the backend URL and server configuration.`
    );
  }

  if (!res.ok) {
    const e = data?.error ?? {};

    throw new ApiError(
      res.status,
      e.code ?? 'error',
      e.message ?? 'Request failed.',
      e.details
    );
  }

  return data as T;
}

/* ------------------------------ Toast system ----------------------------- */

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

let toastSeq = 0;
const toastListeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];

function pushToast(kind: Toast['kind'], message: string) {
  const t: Toast = { id: ++toastSeq, kind, message };
  toasts = [...toasts, t];
  toastListeners.forEach((listener) => listener(toasts));

  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((listener) => listener(toasts));
  }, kind === 'error' ? 6000 : 3500);
}

export const toast = {
  success: (message: string) => pushToast('success', message),
  error: (message: string) => pushToast('error', message),
  info: (message: string) => pushToast('info', message),
};

export function useToasts() {
  const [state, setState] = useState<Toast[]>(toasts);

  useEffect(() => {
    toastListeners.add(setState);

    return () => {
      toastListeners.delete(setState);
    };
  }, []);

  return state;
}

/* --------------------------- Theme (light/dark) -------------------------- */

export function useTheme() {
  const [dark, setDark] = useState<boolean>(
    () => localStorage.getItem('ae-theme') === 'dark'
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('ae-theme', dark ? 'dark' : 'light');
  }, [dark]);

  return {
    dark,
    toggle: () => setDark((current) => !current),
  };
}

/* ------------------------------ Date helpers ----------------------------- */

export function todayISO(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

export function prettyDate(iso: string): string {
  if (!iso) return '—';

  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(
    'en-IN',
    {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }
  );
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '—';

  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.round(mins / 60);

  if (hrs < 24) return `${hrs}h ago`;

  return `${Math.round(hrs / 24)}d ago`;
}

/* -------------------------------- Hooks ---------------------------------- */

export function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value);

  useEffect(() => {
    const h = setTimeout(() => setV(value), delay);

    return () => clearTimeout(h);
  }, [value, delay]);

  return v;
}

/** Undo stack for accidental attendance taps. */
export function useUndoableMap<T extends string>() {
  const [state, setState] = useState<Record<number, T>>({});
  const history = useRef<{ id: number; prev: T | undefined }[]>([]);

  const set = useCallback((id: number, value: T) => {
    setState((prev) => {
      history.current.push({ id, prev: prev[id] });

      if (history.current.length > 60) {
        history.current.shift();
      }

      return { ...prev, [id]: value };
    });
  }, []);

  const undo = useCallback(() => {
    const last = history.current.pop();

    if (!last) return false;

    setState((prev) => {
      const next = { ...prev };

      if (last.prev === undefined) {
        delete next[last.id];
      } else {
        next[last.id] = last.prev;
      }

      return next;
    });

    return true;
  }, []);

  const reset = useCallback((next: Record<number, T>) => {
    history.current = [];
    setState(next);
  }, []);

  return {
    state,
    set,
    undo,
    reset,
    canUndo: history.current.length > 0,
  };
}

export function useOnce<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;

    setLoading(true);
    setError(null);

    fn()
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return {
    data,
    loading,
    error,
    reload: () => setTick((t) => t + 1),
    setData,
  };
}

/** Minimal safe download for authenticated export endpoints. */
export async function downloadFile(path: string, fallbackName: string) {
  const apiBase = getApiBase();

  const res = await fetch(`${apiBase}/api${path}`, {
    credentials: apiBase ? 'include' : 'same-origin',
    headers: getApiHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    let msg = 'Export failed.';

    try {
      msg = JSON.parse(text)?.error?.message ?? msg;
    } catch {
      // Ignore non-JSON error responses.
    }

    throw new Error(msg);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const name = match?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 4000);

  return name;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia(query).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = () => setMatches(mq.matches);

    mq.addEventListener('change', handler);

    return () => mq.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

export const STATUS_META: Record<
  string,
  { label: string; short: string; cls: string; dot: string }
> = {
  present: {
    label: 'Present',
    short: 'P',
    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dot: 'bg-emerald-500',
  },
  absent: {
    label: 'Absent',
    short: 'A',
    cls: 'bg-red-50 text-red-700 border-red-200',
    dot: 'bg-red-500',
  },
  leave: {
    label: 'On Leave',
    short: 'L',
    cls: 'bg-amber-50 text-amber-700 border-amber-200',
    dot: 'bg-amber-500',
  },
  half_day: {
    label: 'Half Day',
    short: 'H',
    cls: 'bg-sky-50 text-sky-700 border-sky-200',
    dot: 'bg-sky-500',
  },
};

export function usePermissions(role: Role | undefined) {
  return useMemo(() => {
    const isAdmin = role === 'admin';
    const isHod = role === 'hod';
    const isTeacher = role === 'teacher';

    return {
      canMarkStudent: isAdmin || isHod || isTeacher,
      canMarkStaff: isAdmin || isHod,
      canManage: isAdmin,
      canApprove: isAdmin || isHod,
      canViewReports: isAdmin || isHod || isTeacher,
      canViewAudit: isAdmin || isHod,
      canConfigureSms: isAdmin || isHod,
    };
  }, [role]);
}
