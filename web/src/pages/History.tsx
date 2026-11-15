import { useMemo, useState } from 'react';
import { api, prettyDate, timeAgo, toast, todayISO, useOnce } from '../lib/api';
import { EmptyState, ErrorBox, Spinner, StatusPill } from '../components/ui';
import { PageHeader } from '../components/AppShell';

interface Session {
  id: number;
  kind: string;
  session_date: string;
  period_no: number;
  status: string;
  submitted_at: string;
  department_code: string;
  class_name: string | null;
  section: string | null;
  subject_code: string | null;
  subject_name: string | null;
  taken_by: string;
  present: number;
  absent: number;
  on_leave: number;
  staff_present: number;
  staff_absent: number;
}

export function HistoryPage() {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(todayISO());
  const [kind, setKind] = useState('');
  const [deptId, setDeptId] = useState('');
  const [mine, setMine] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const depts = useOnce(() => api<{ departments: Array<{ id: number; code: string }> }>('/departments'));

  const qs = new URLSearchParams({ from, to });
  if (kind) qs.set('kind', kind);
  if (deptId) qs.set('department_id', deptId);
  if (mine) qs.set('mine', '1');
  const sessions = useOnce(() => api<{ sessions: Session[] }>(`/attendance/sessions?${qs.toString()}`), [from, to, kind, deptId, mine]);
  const detail = useOnce(
    () => (openId ? api<{ session: Session; student_records: Array<Record<string, string | number>>; staff_records: Array<Record<string, string | number>> }>(`/attendance/sessions/${openId}`) : Promise.resolve(null)),
    [openId],
  );

  const rows = sessions.data?.sessions ?? [];
  const totals = useMemo(
    () => ({
      sessions: rows.length,
      present: rows.reduce((a, r) => a + Number(r.present) + Number(r.staff_present), 0),
      absent: rows.reduce((a, r) => a + Number(r.absent) + Number(r.staff_absent), 0),
    }),
    [rows],
  );

  async function lock(id: number, locked: boolean) {
    try {
      await api(`/attendance/sessions/${id}/lock`, { json: { locked } });
      toast.success(locked ? 'Session locked.' : 'Session unlocked.');
      sessions.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the session.');
    }
  }

  return (
    <>
      <PageHeader title="Attendance history" subtitle="Every submitted session with the teacher who took it" />

      <div className="card p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div>
            <label className="label" htmlFor="from">
              From
            </label>
            <input id="from" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="to">
              To
            </label>
            <input id="to" type="date" className="input" value={to} max={todayISO()} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="kind">
              Type
            </label>
            <select id="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All</option>
              <option value="student">Student</option>
              <option value="staff">Staff</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="dep">
              Department
            </label>
            <select id="dep" className="input" value={deptId} onChange={(e) => setDeptId(e.target.value)}>
              <option value="">All</option>
              {(depts.data?.departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border px-3 text-sm" style={{ borderColor: 'var(--border)' }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              Only mine
            </label>
          </div>
        </div>
      </div>

      {sessions.loading ? (
        <Spinner />
      ) : sessions.error ? (
        <ErrorBox message={sessions.error} onRetry={sessions.reload} />
      ) : (
        <div className="card mt-4 overflow-hidden">
          <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <h2 className="font-semibold">
              {totals.sessions} session(s) <span className="muted text-sm">• {totals.present} present • {totals.absent} absent</span>
            </h2>
          </div>
          {!rows.length ? (
            <EmptyState title="No sessions in this range" hint="Try widening the date range." />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Dept</th>
                    <th>Class / type</th>
                    <th>Subject</th>
                    <th>Period</th>
                    <th>Present</th>
                    <th>Absent</th>
                    <th>Taken by</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id}>
                      <td className="whitespace-nowrap">{prettyDate(s.session_date)}</td>
                      <td>{s.department_code}</td>
                      <td>{s.kind === 'staff' ? 'Staff (dept)' : `${s.class_name} ${s.section ? `• ${s.section}` : ''}`}</td>
                      <td>{s.subject_code ?? '—'}</td>
                      <td>P{s.period_no}</td>
                      <td className="tabular-nums text-emerald-600">{s.kind === 'staff' ? s.staff_present : s.present}</td>
                      <td className="tabular-nums text-red-600">{s.kind === 'staff' ? s.staff_absent : s.absent}</td>
                      <td className="whitespace-nowrap">{s.taken_by}</td>
                      <td>
                        <StatusPill status={s.status} />
                      </td>
                      <td className="text-right">
                        <button className="text-xs font-medium text-cyan-700 hover:underline" onClick={() => setOpenId(s.id)}>
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {openId && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-[color:var(--surface)] p-4 shadow-pop sm:rounded-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Session #{openId}</h2>
                {detail.data?.session && (
                  <p className="text-sm muted">
                    {prettyDate(detail.data.session.session_date)} • P{detail.data.session.period_no} •{' '}
                    {detail.data.session.taken_by}
                  </p>
                )}
              </div>
              <button className="btn-ghost" onClick={() => setOpenId(null)}>
                Close
              </button>
            </div>

            {detail.loading ? (
              <Spinner />
            ) : detail.data ? (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="btn-ghost"
                    onClick={() => void lock(openId, detail.data!.session.status !== 'locked')}
                  >
                    {detail.data.session.status === 'locked' ? 'Unlock session' : 'Lock session'}
                  </button>
                  <span className="chip border" style={{ borderColor: 'var(--border)' }}>
                    Submitted {timeAgo(detail.data.session.submitted_at)}
                  </span>
                </div>
                <div className="mt-3 table-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Roll / code</th>
                        <th>Name</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detail.data.student_records.length ? detail.data.student_records : detail.data.staff_records).map((r) => (
                        <tr key={String(r.id)}>
                          <td className="tabular-nums">{String(r.roll_no ?? r.staff_code)}</td>
                          <td>{String(r.full_name)}</td>
                          <td>
                            <StatusPill status={String(r.status)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <ErrorBox message="Could not load this session." />
            )}
          </div>
        </div>
      )}
    </>
  );
}
