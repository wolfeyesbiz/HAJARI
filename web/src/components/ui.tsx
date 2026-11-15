import { useEffect } from 'react';
import { toast, useToasts } from '../lib/api';

export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      className="fixed inset-x-3 bottom-4 z-[100] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:items-end"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`w-full max-w-sm rounded-xl px-4 py-3 text-sm shadow-pop border flex items-start gap-2.5 ${
            t.kind === 'success'
              ? 'bg-emerald-600 text-white border-emerald-700'
              : t.kind === 'error'
                ? 'bg-red-600 text-white border-red-700'
                : 'bg-navy-900 text-white border-navy-950'
          }`}
        >
          <span aria-hidden className="mt-0.5">
            {t.kind === 'success' ? '✓' : t.kind === 'error' ? '!' : 'i'}
          </span>
          <span className="flex-1">{t.message}</span>
        </div>
      ))}
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
  busy,
}: ConfirmProps) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="w-full max-w-md rounded-t-2xl sm:rounded-2xl bg-[color:var(--surface)] p-5 shadow-pop">
        <h2 id="confirm-title" className="text-lg font-semibold">
          {title}
        </h2>
        <div className="mt-2 text-sm muted leading-relaxed">{message}</div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={() => void onConfirm()} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="h-12 w-12 rounded-full border border-dashed" style={{ borderColor: 'var(--border)' }} />
      <p className="font-medium">{title}</p>
      {hint && <p className="text-sm muted max-w-sm">{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 justify-center text-sm muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-500 border-t-transparent" />
      {label}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      <p className="font-medium">Something went wrong</p>
      <p className="mt-1">{message}</p>
      {onRetry && (
        <button className="btn-ghost mt-3" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    present: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    absent: 'bg-red-50 text-red-700 border-red-200',
    leave: 'bg-amber-50 text-amber-700 border-amber-200',
    half_day: 'bg-sky-50 text-sky-700 border-sky-200',
    submitted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    locked: 'bg-navy-100 text-navy-800 border-navy-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    rejected: 'bg-red-50 text-red-700 border-red-200',
    sent: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    delivered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
    not_sent: 'bg-slate-100 text-slate-700 border-slate-300',
  };
  const label = status.replace('_', ' ');
  return <span className={`chip capitalize ${map[status] ?? 'bg-slate-100 text-slate-700 border-slate-300'}`}>{label}</span>;
}

/** Small helper so the mark-attendance screens can surface API failures consistently. */
export function reportError(err: unknown) {
  const msg = err instanceof Error ? err.message : 'Unexpected error.';
  toast.error(msg);
}
