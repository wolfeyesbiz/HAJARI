import { useEffect, useMemo, useState } from 'react';
import { api, prettyDate, toast, todayISO, useOnce } from '../lib/api';
import { ConfirmDialog, EmptyState, ErrorBox, Spinner } from '../components/ui';
import { PageHeader } from '../components/AppShell';

type StaffStatus = 'present' | 'absent' | 'leave' | 'half_day';

interface StaffRow {
  id: number;
  staff_code: string;
  full_name: string;
  designation: string;
  employment_type: string;
  phone: string | null;
}

interface RosterResp {
  staff: StaffRow[];
  session: { id: number; status: string } | null;
  date: string;
  prior: Array<{ staff_id: number; status: StaffStatus }>;
}

const COLORS: Record<StaffStatus, string> = {
  present: 'bg-emerald-600 text-white border-emerald-600',
  absent: 'bg-red-600 text-white border-red-600',
  leave: 'bg-amber-500 text-white border-amber-500',
  half_day: 'bg-sky-600 text-white border-sky-600',
};
const OFF = 'bg-[color:var(--surface)] border-[color:var(--border)] hover:border-slate-400';

export function StaffAttendancePage() {
  const { me } = useAuthSafe();
  const depts = useOnce(() => api<{ departments: Array<{ id: number; code: string; name: string }> }>('/departments'));
  const [deptId, setDeptId] = useState<string>('');
  const [date, setDate] = useState(todayISO());
  const [period, setPeriod] = useState('1');
  const [data, setData] = useState<RosterResp | null>(null);
  const [marks, setMarks] = useState<Record<number, StaffStatus>>({});
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!deptId && depts.data?.departments.length) {
      setDeptId(String(me?.user.department_id ?? depts.data.departments[0].id));
    }
  }, [depts.data, deptId, me]);

  async function load() {
    if (!deptId) return;
    setLoading(true);
    try {
      const r = await api<RosterResp>(`/attendance/staff/roster?department_id=${deptId}&date=${date}&period_no=${period}`);
      setData(r);
      const m: Record<number, StaffStatus> = {};
      if (r.prior.length) r.prior.forEach((p) => (m[p.staff_id] = p.status));
      else r.staff.forEach((s) => (m[s.id] = 'present'));
      setMarks(m);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load staff list.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deptId, date, period]);

  const summary = useMemo(() => {
    const v = Object.values(marks);
    return {
      total: v.length,
      present: v.filter((x) => x === 'present').length,
      absent: v.filter((x) => x === 'absent').length,
      leave: v.filter((x) => x === 'leave').length,
      half: v.filter((x) => x === 'half_day').length,
    };
  }, [marks]);

  async function submit() {
    setBusy(true);
    try {
      const records = (data?.staff ?? []).map((s) => ({ staff_id: s.id, status: marks[s.id] ?? 'present' }));
      const res = await api<{ sms: { queued: number } }>('/attendance/staff', {
        json: {
          department_id: Number(deptId),
          date,
          period_no: Number(period),
          records,
          confirm_overwrite: Boolean(data?.session),
        },
      });
      toast.success('Staff attendance saved.');
      if (res.sms?.queued) toast.info(`${res.sms.queued} staff SMS queued.`);
      setConfirming(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save staff attendance.');
    } finally {
      setBusy(false);
    }
  }

  const grouped = useMemo(() => {
    const teaching = (data?.staff ?? []).filter((s) => s.employment_type === 'teaching');
    const nonTeaching = (data?.staff ?? []).filter((s) => s.employment_type !== 'teaching');
    return { teaching, nonTeaching };
  }, [data]);

  return (
    <>
      <PageHeader title="Staff attendance" subtitle="Mark the whole department in a few taps" />
      <div className="card p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className="label" htmlFor="sd">
              Department
            </label>
            <select id="sd" className="input" value={deptId} onChange={(e) => setDeptId(e.target.value)}>
              {(depts.data?.departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="sdate">
              Date
            </label>
            <input id="sdate" type="date" className="input" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="speriod">
              Session
            </label>
            <select id="speriod" className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="1">Full day (morning)</option>
              <option value="5">Afternoon</option>
            </select>
          </div>
          <div className="flex items-end gap-2">
            <button className="btn-primary w-full" onClick={() => setConfirming(true)} disabled={!data?.staff.length || busy}>
              Save attendance
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <Spinner label="Loading staff…" />
      ) : !data?.staff.length ? (
        <div className="card mt-4 p-6">
          <EmptyState title="No active staff in this department" hint="Add staff from Administration → Staff." />
        </div>
      ) : (
        <>
          {data.session && (
            <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Attendance already exists for {prettyDate(date)} — saving replaces it and is audited.
            </p>
          )}
          {[
            ['Teaching staff', grouped.teaching],
            ['Non-teaching staff', grouped.nonTeaching],
          ].map(([label, list]) => {
            const rows = list as StaffRow[];
            if (!rows.length) return null;
            return (
              <div key={String(label)} className="card mt-4 overflow-hidden">
                <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: 'var(--border)' }}>
                  <h2 className="text-sm font-semibold">
                    {String(label)} <span className="muted">({rows.length})</span>
                  </h2>
                  <button
                    className="text-xs font-medium text-cyan-700 hover:underline"
                    onClick={() => {
                      const m = { ...marks };
                      rows.forEach((r) => (m[r.id] = 'present'));
                      setMarks(m);
                      toast.success(`All ${String(label).toLowerCase()} marked present.`);
                    }}
                  >
                    All present
                  </button>
                </div>
                <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
                  {rows.map((s) => {
                    const st = marks[s.id] ?? 'present';
                    return (
                      <li key={s.id} className="flex flex-wrap items-center gap-2 p-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{s.full_name}</p>
                          <p className="text-[11px] muted">
                            {s.staff_code} • {s.designation}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          {(['present', 'absent', 'leave', 'half_day'] as StaffStatus[]).map((k) => (
                            <button
                              key={k}
                              aria-pressed={st === k}
                              aria-label={`${s.full_name} ${k.replace('_', ' ')}`}
                              onClick={() => setMarks({ ...marks, [s.id]: k })}
                              className={`h-10 min-w-[42px] rounded-lg border px-2 text-[11px] font-semibold ${st === k ? COLORS[k] : OFF}`}
                            >
                              {k === 'present' ? 'P' : k === 'absent' ? 'A' : k === 'leave' ? 'L' : 'HD'}
                            </button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          <div className="sticky bottom-3 mt-4 flex flex-wrap items-center gap-2 rounded-xl border bg-[color:var(--surface)] p-3 shadow-card" style={{ borderColor: 'var(--border)' }}>
            <p className="text-sm">
              {summary.total} staff • <span className="text-emerald-600">{summary.present} present</span> •{' '}
              <span className="text-red-600">{summary.absent} absent</span> • <span className="text-amber-600">{summary.leave} leave</span> •{' '}
              <span className="text-sky-600">{summary.half} half day</span>
            </p>
            <button className="btn-primary ml-auto" onClick={() => setConfirming(true)} disabled={busy}>
              Submit
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming}
        busy={busy}
        title="Submit staff attendance?"
        confirmLabel={data?.session ? 'Replace and submit' : 'Submit'}
        message={`${depts.data?.departments.find((d) => String(d.id) === deptId)?.code} • ${prettyDate(date)} — ${summary.present} present, ${summary.absent} absent, ${summary.leave} on leave, ${summary.half} half day.`}
        onCancel={() => setConfirming(false)}
        onConfirm={submit}
      />
    </>
  );
}

import { useAuth } from '../lib/auth';
function useAuthSafe() {
  return useAuth();
}
