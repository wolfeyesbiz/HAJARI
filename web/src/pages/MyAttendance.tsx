import { api, prettyDate, useOnce } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, ErrorBox, Spinner, StatusPill } from '../components/ui';
import { PageHeader } from '../components/AppShell';

interface MineResp {
  rows: Array<{ date: string; status: string; label: string; extra?: string }>;
  summary: { total: number; present: number; absent: number; percentage: number };
}

export function MyAttendancePage() {
  const { me } = useAuth();
  const isStudent = me?.user.role === 'student';
  const data = useOnce(async () => {
    if (isStudent && me?.user.student_id) {
      const sessions = await api<{ sessions: Array<Record<string, unknown>> }>('/attendance/sessions?kind=student');
      const detail = await Promise.all(
        sessions.sessions.slice(0, 40).map((s) =>
          api<{ student_records: Array<{ student_id: number; status: string }> }>(`/attendance/sessions/${s.id}`)
            .then((d) => ({ s, rec: d.student_records.find((r) => r.student_id === me.user.student_id) }))
            .catch(() => ({ s, rec: undefined })),
        ),
      );
      const rows = detail
        .filter((d) => d.rec)
        .map((d) => ({
          date: String(d.s.session_date),
          status: String(d.rec!.status),
          label: `${d.s.class_name ?? ''} • ${d.s.subject_code ?? ''} • P${d.s.period_no}`,
        }));
      const present = rows.filter((r) => r.status === 'present').length;
      return {
        rows,
        summary: { total: rows.length, present, absent: rows.filter((r) => r.status === 'absent').length, percentage: rows.length ? Math.round((present / rows.length) * 1000) / 10 : 0 },
      } as MineResp;
    }
    // Staff & teachers: their own monthly staff attendance
    const sessions = await api<{ sessions: Array<Record<string, unknown>> }>('/attendance/sessions?kind=staff');
    const detail = await Promise.all(
      sessions.sessions.slice(0, 60).map((s) =>
        api<{ staff_records: Array<{ staff_id: number; status: string; full_name: string }> }>(`/attendance/sessions/${s.id}`)
          .then((d) => ({ s, rec: d.staff_records.find((r) => r.staff_id === me?.user.staff_id) }))
          .catch(() => ({ s, rec: undefined })),
      ),
    );
    const rows = detail
      .filter((d) => d.rec)
      .map((d) => ({ date: String(d.s.session_date), status: String(d.rec!.status), label: `Department session • P${d.s.period_no}` }));
    const present = rows.filter((r) => r.status === 'present').length;
    return {
      rows,
      summary: { total: rows.length, present, absent: rows.filter((r) => r.status === 'absent').length, percentage: rows.length ? Math.round((present / rows.length) * 1000) / 10 : 0 },
    } as MineResp;
  });

  if (data.loading) return <Spinner />;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  const d = data.data;

  return (
    <>
      <PageHeader title="My attendance" subtitle={isStudent ? 'Your recorded attendance' : 'Your staff attendance record'} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wide muted">Overall</p>
          <p className={`text-2xl font-semibold ${Number(d?.summary.percentage) >= 75 ? 'text-emerald-600' : 'text-red-600'}`}>
            {d?.summary.percentage ?? 0}%
          </p>
        </div>
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wide muted">Sessions</p>
          <p className="text-2xl font-semibold tabular-nums">{d?.summary.total ?? 0}</p>
        </div>
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wide muted">Present</p>
          <p className="text-2xl font-semibold tabular-nums text-emerald-600">{d?.summary.present ?? 0}</p>
        </div>
        <div className="card p-4">
          <p className="text-[11px] uppercase tracking-wide muted">Absent</p>
          <p className="text-2xl font-semibold tabular-nums text-red-600">{d?.summary.absent ?? 0}</p>
        </div>
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          <h2 className="font-semibold">Recent records</h2>
        </div>
        {!d?.rows.length ? (
          <EmptyState title="No records yet" hint="Your attendance will appear here once your teacher marks it." />
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {d.rows.map((r, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div>
                  <p className="font-medium">{prettyDate(r.date)}</p>
                  <p className="text-[11px] muted">{r.label}</p>
                </div>
                <StatusPill status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
