import { useState } from 'react';
import { api, prettyDate, toast, useOnce } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ConfirmDialog, EmptyState, ErrorBox, Spinner, StatusPill } from '../components/ui';
import { PageHeader } from '../components/AppShell';

interface Correction {
  id: number;
  session_id: number;
  record_type: string;
  old_status: string | null;
  new_status: string;
  reason: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  session_date: string;
  department_code: string;
  person_name: string;
  person_code: string;
  requested_by_name: string;
  decided_by_name: string | null;
}

export function CorrectionsPage() {
  const { me } = useAuth();
  const [status, setStatus] = useState('pending');
  const list = useOnce(() => api<{ corrections: Correction[] }>(`/attendance/corrections?status=${status || ''}`), [status]);
  const [decision, setDecision] = useState<{ c: Correction; action: 'approved' | 'rejected' } | null>(null);
  const [busy, setBusy] = useState(false);
  const canApprove = me?.user.role === 'admin' || me?.user.role === 'hod';

  async function decide() {
    if (!decision) return;
    setBusy(true);
    try {
      await api(`/attendance/corrections/${decision.c.id}/decide`, { json: { decision: decision.action } });
      toast.success(`Correction ${decision.action}.`);
      setDecision(null);
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the decision.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Attendance corrections"
        subtitle={canApprove ? 'Approve or reject corrections requested by teachers' : 'Track the corrections you requested'}
        actions={
          <select className="input max-w-[180px]" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="">All</option>
          </select>
        }
      />

      {list.loading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorBox message={list.error} onRetry={list.reload} />
      ) : !list.data?.corrections.length ? (
        <div className="card p-6">
          <EmptyState
            title="No correction requests"
            hint="Submitted attendance cannot be edited directly. A teacher raises a correction with a reason, and the HOD approves it."
          />
        </div>
      ) : (
        <div className="space-y-3">
          {list.data.corrections.map((c) => (
            <div key={c.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {c.person_name} <span className="muted text-sm">({c.person_code})</span>
                  </p>
                  <p className="text-xs muted">
                    {c.department_code} • {prettyDate(c.session_date)} • session #{c.session_id} • requested by{' '}
                    {c.requested_by_name}
                  </p>
                </div>
                <StatusPill status={c.status} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <StatusPill status={c.old_status ?? 'absent'} />
                <span aria-hidden>→</span>
                <StatusPill status={c.new_status} />
              </div>
              <p className="mt-2 rounded-lg bg-[color:var(--surface-2)] p-2.5 text-sm">“{c.reason}”</p>
              {c.status === 'pending' && canApprove && (
                <div className="mt-3 flex gap-2">
                  <button className="btn-primary" onClick={() => setDecision({ c, action: 'approved' })}>
                    Approve
                  </button>
                  <button className="btn-ghost" onClick={() => setDecision({ c, action: 'rejected' })}>
                    Reject
                  </button>
                </div>
              )}
              {c.decided_by_name && (
                <p className="mt-2 text-xs muted">
                  {c.status} by {c.decided_by_name} • {c.decided_at ? prettyDate(c.decided_at.slice(0, 10)) : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(decision)}
        busy={busy}
        title={decision?.action === 'approved' ? 'Approve this correction?' : 'Reject this correction?'}
        message={
          decision
            ? `${decision.c.person_name}: ${decision.c.old_status} → ${decision.c.new_status}. ${
                decision.action === 'approved'
                  ? 'The attendance record will be updated and the change written to the audit log.'
                  : 'The attendance record stays unchanged; the request is closed.'
              }`
            : ''
        }
        confirmLabel={decision?.action === 'approved' ? 'Approve' : 'Reject'}
        danger={decision?.action === 'rejected'}
        onCancel={() => setDecision(null)}
        onConfirm={decide}
      />
    </>
  );
}
