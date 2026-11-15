import { useEffect, useMemo, useState } from 'react';
import { api, prettyDate, toast, todayISO, useDebounced, useOnce } from '../lib/api';
import { ConfirmDialog, EmptyState, ErrorBox, Spinner } from '../components/ui';
import { PageHeader } from '../components/AppShell';

interface Assignment {
  class_id: number;
  class_name: string;
  semester: number;
  section: string;
  subject_id: number;
  subject_code: string;
  subject_name: string;
  department_code: string;
  department_name: string;
}

interface Student {
  id: number;
  roll_no: string;
  full_name: string;
  guardian_phone: string | null;
}

interface Roster {
  students: Student[];
  subject: { code: string; name: string } | null;
  class: { name: string; section: string } | null;
  period: { label: string } | null;
  date: string;
  session: { id: number; status: string; taken_by: string } | null;
}

type Status = 'present' | 'absent' | 'leave';

const BTN: Record<Status, string> = {
  present: 'bg-emerald-600 text-white border-emerald-600',
  absent: 'bg-red-600 text-white border-red-600',
  leave: 'bg-amber-500 text-white border-amber-500',
};
const OFF = 'bg-[color:var(--surface)] border-[color:var(--border)] hover:border-slate-400';

export function StudentAttendancePage() {
  const ctx = useOnce(() => api<{ assignments: Assignment[]; today: string; periods?: unknown }>('/attendance/student/context'));
  const periods = useOnce(() => api<{ periods: Array<{ period_no: number; label: string; start_time: string }> }>('/periods'));

  const [dept, setDept] = useState('');
  const [classId, setClassId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [periodNo, setPeriodNo] = useState('1');
  const [date, setDate] = useState(todayISO());
  const [search, setSearch] = useState('');
  const [sortAlpha, setSortAlpha] = useState(true);
  const [marks, setMarks] = useState<Record<number, Status>>({});
  const [history, setHistory] = useState<Array<{ id: number; prev?: Status }>>([]);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [loadingRoster, setLoadingRoster] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const debouncedSearch = useDebounced(search);

  const assignments = ctx.data?.assignments ?? [];
  const depts = useMemo(() => {
    const m = new Map<string, string>();
    assignments.forEach((a) => m.set(a.department_code, a.department_name));
    return Array.from(m.entries());
  }, [assignments]);

  useEffect(() => {
    if (!dept && depts.length) setDept(depts[0][0]);
  }, [depts, dept]);

  const classes = useMemo(() => {
    const m = new Map<string, { id: number; label: string }>();
    assignments.filter((a) => a.department_code === dept).forEach((a) =>
      m.set(`${a.class_id}-${a.section}`, { id: a.class_id, label: `${a.class_name} — Sec ${a.section}` }),
    );
    return Array.from(m.values());
  }, [assignments, dept]);

  useEffect(() => {
    if (classes.length && !classes.some((c) => String(c.id) === classId)) setClassId(String(classes[0].id));
  }, [classes, classId]);

  const subjects = useMemo(
    () => assignments.filter((a) => String(a.class_id) === classId),
    [assignments, classId],
  );

  useEffect(() => {
    if (subjects.length && !subjects.some((s) => String(s.subject_id) === subjectId)) setSubjectId(String(subjects[0].subject_id));
  }, [subjects, subjectId]);

  const contextReady = classId && subjectId && periodNo && date;

  async function loadRoster() {
    if (!contextReady) return;
    setLoadingRoster(true);
    try {
      const r = await api<Roster>(
        `/attendance/student/roster?class_id=${classId}&subject_id=${subjectId}&period_no=${periodNo}&date=${date}`,
      );
      setRoster(r);
      if (r.session) {
        // Existing session: load its saved marks so the teacher sees what was recorded.
        const detail = await api<{ student_records: Array<{ student_id: number; status: Status }> }>(
          `/attendance/sessions/${r.session.id}`,
        );
        const m: Record<number, Status> = {};
        detail.student_records.forEach((rec) => (m[rec.student_id] = rec.status));
        setMarks(m);
        setHistory([]);
      } else {
        setMarks({});
        setHistory([]);
        // Default: everyone present (most common case → fewer taps).
        const m: Record<number, Status> = {};
        r.students.forEach((s) => (m[s.id] = 'present'));
        setMarks(m);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the class list.');
      setRoster(null);
    } finally {
      setLoadingRoster(false);
    }
  }

  useEffect(() => {
    void loadRoster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, subjectId, periodNo, date]);

  function mark(id: number, status: Status) {
    setHistory((h) => [...h.slice(-59), { id, prev: marks[id] }]);
    setMarks((m) => ({ ...m, [id]: status }));
  }

  function undo() {
    const last = history[history.length - 1];
    if (!last) return;
    setMarks((m) => {
      const next = { ...m };
      if (last.prev === undefined) delete next[last.id];
      else next[last.id] = last.prev;
      return next;
    });
    setHistory((h) => h.slice(0, -1));
  }

  const visible = useMemo(() => {
    const list = (roster?.students ?? []).filter(
      (s) =>
        !debouncedSearch ||
        s.full_name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
        s.roll_no.toLowerCase().includes(debouncedSearch.toLowerCase()),
    );
    return sortAlpha ? [...list].sort((a, b) => a.full_name.localeCompare(b.full_name)) : list;
  }, [roster, debouncedSearch, sortAlpha]);

  const summary = useMemo(() => {
    const values = Object.values(marks);
    return {
      total: values.length,
      present: values.filter((v) => v === 'present').length,
      absent: values.filter((v) => v === 'absent').length,
      leave: values.filter((v) => v === 'leave').length,
    };
  }, [marks]);

  const alreadyRecorded = Boolean(roster?.session);

  async function submit() {
    if (!roster) return;
    setBusy(true);
    try {
      const records = roster.students.map((s) => ({ student_id: s.id, status: marks[s.id] ?? 'present' }));
      const res = await api<{ summary: { total: number; absent: number }; sms: { queued: number } }>('/attendance/student', {
        json: {
          class_id: Number(classId),
          subject_id: Number(subjectId),
          period_no: Number(periodNo),
          date,
          records,
          confirm_overwrite: alreadyRecorded,
        },
      });
      toast.success(`Attendance saved — ${res.summary.total - res.summary.absent} present, ${res.summary.absent} absent.`);
      if (res.sms?.queued) toast.info(`${res.sms.queued} SMS notification(s) queued.`);
      setConfirming(false);
      await loadRoster();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save attendance.');
    } finally {
      setBusy(false);
    }
  }

  if (ctx.loading) return <Spinner label="Loading your classes…" />;
  if (ctx.error) return <ErrorBox message={ctx.error} onRetry={ctx.reload} />;

  if (!assignments.length) {
    return (
      <>
        <PageHeader title="Student attendance" />
        <div className="card p-6">
          <EmptyState
            title="No classes assigned to you yet"
            hint="Ask the administrator to assign you to a class and subject. Once assigned, your classes appear here automatically."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Student attendance"
        subtitle="Pick the class, then tap Present / Absent / On Leave for each student"
        actions={
          <button className="btn-ghost" onClick={() => void loadRoster()} disabled={loadingRoster}>
            ⟳ Reload
          </button>
        }
      />

      <div className="card p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <div>
            <label className="label" htmlFor="dept">
              Department
            </label>
            <select id="dept" className="input" value={dept} onChange={(e) => setDept(e.target.value)}>
              {depts.map(([code, name]) => (
                <option key={code} value={code}>
                  {code} — {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="class">
              Class / section
            </label>
            <select id="class" className="input" value={classId} onChange={(e) => setClassId(e.target.value)}>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="subject">
              Subject
            </label>
            <select id="subject" className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {subjects.map((s) => (
                <option key={s.subject_id} value={s.subject_id}>
                  {s.subject_code} — {s.subject_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="period">
              Period
            </label>
            <select id="period" className="input" value={periodNo} onChange={(e) => setPeriodNo(e.target.value)}>
              {(periods.data?.periods ?? []).map((p) => (
                <option key={p.period_no} value={p.period_no}>
                  {p.label} ({p.start_time})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="date">
              Date
            </label>
            <input id="date" type="date" className="input" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
      </div>

      {alreadyRecorded && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Already recorded.</strong> {roster?.class?.name} • {roster?.subject?.code} • P{periodNo} • {prettyDate(date)} was
          submitted by {roster?.session?.taken_by}. Saving again replaces the whole session and is written to the audit log.
        </div>
      )}

      <div className="mt-4 card">
        <div className="sticky top-0 z-10 -mx-px rounded-t-xl border-b bg-[color:var(--surface)] p-3" style={{ borderColor: 'var(--border)' }}>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input max-w-xs flex-1"
              placeholder="Search name or roll no"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search students"
            />
            <button className="btn-ghost" onClick={() => setSortAlpha((s) => !s)}>
              {sortAlpha ? 'A–Z' : 'Roll order'}
            </button>
            <button
              className="btn-ghost"
              onClick={() => {
                const m: Record<number, Status> = {};
                roster?.students.forEach((s) => (m[s.id] = 'present'));
                setHistory([]);
                setMarks(m);
              }}
            >
              Select all present
            </button>
            <button
              className="btn-ghost"
              onClick={() => {
                const m: Record<number, Status> = {};
                roster?.students.forEach((s) => (m[s.id] = s.roll_no === search ? 'absent' : marks[s.id] ?? 'present'));
                // "Mark only searched student absent" keeps the rest untouched.
                setMarks((prev) => ({ ...prev, ...m }));
              }}
            >
              Mark found absent
            </button>
            <button className="btn-ghost" onClick={undo} disabled={!history.length}>
              ↺ Undo
            </button>
            <div className="ml-auto flex items-center gap-2 text-xs">
              <span className="chip border-emerald-200 bg-emerald-50 text-emerald-700">P {summary.present}</span>
              <span className="chip border-red-200 bg-red-50 text-red-700">A {summary.absent}</span>
              <span className="chip border-amber-200 bg-amber-50 text-amber-700">L {summary.leave}</span>
            </div>
          </div>
        </div>

        {loadingRoster ? (
          <Spinner label="Loading students…" />
        ) : !roster?.students.length ? (
          <EmptyState title="No students in this class" hint="Add students from Administration → Students." />
        ) : (
          <>
            {/* Mobile: cards. Desktop: table. Same data, touch-friendly targets. */}
            <ul className="divide-y sm:hidden" style={{ borderColor: 'var(--border)' }}>
              {visible.map((s) => {
                const st = marks[s.id] ?? 'present';
                return (
                  <li key={s.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{s.full_name}</p>
                        <p className="text-[11px] muted">{s.roll_no}</p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {(['present', 'absent', 'leave'] as Status[]).map((k) => (
                          <button
                            key={k}
                            aria-pressed={st === k}
                            aria-label={`${s.full_name} ${k}`}
                            onClick={() => mark(s.id, k)}
                            className={`h-11 w-11 rounded-lg border text-sm font-semibold ${st === k ? BTN[k] : OFF}`}
                          >
                            {k === 'present' ? 'P' : k === 'absent' ? 'A' : 'L'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="hidden sm:block table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Roll no</th>
                    <th>Student</th>
                    <th className="text-right">Mark attendance</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((s) => {
                    const st = marks[s.id] ?? 'present';
                    return (
                      <tr key={s.id}>
                        <td className="tabular-nums">{s.roll_no}</td>
                        <td className="font-medium">{s.full_name}</td>
                        <td>
                          <div className="flex justify-end gap-1.5">
                            {(['present', 'absent', 'leave'] as Status[]).map((k) => (
                              <button
                                key={k}
                                aria-pressed={st === k}
                                onClick={() => mark(s.id, k)}
                                className={`min-h-[38px] rounded-lg border px-3 text-xs font-semibold capitalize ${st === k ? BTN[k] : OFF}`}
                              >
                                {k === 'leave' ? 'On leave' : k}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-[color:var(--surface)] p-3" style={{ borderColor: 'var(--border)' }}>
              <p className="text-sm">
                <span className="font-medium">{summary.total}</span> students •{' '}
                <span className="text-emerald-600">{summary.present} present</span> •{' '}
                <span className="text-red-600">{summary.absent} absent</span> •{' '}
                <span className="text-amber-600">{summary.leave} on leave</span>
              </p>
              <button className="btn-primary ml-auto" onClick={() => setConfirming(true)} disabled={busy || !summary.total}>
                Review & submit
              </button>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        title="Submit attendance?"
        busy={busy}
        confirmLabel={alreadyRecorded ? 'Replace and submit' : 'Submit attendance'}
        message={
          <div className="space-y-2">
            <p>
              {roster?.class?.name} • Sec {roster?.class?.section} • {roster?.subject?.code} • {roster?.period?.label} •{' '}
              {prettyDate(date)}
            </p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">
                <p className="text-lg font-semibold tabular-nums">{summary.present}</p>
                <p className="text-[11px]">Present</p>
              </div>
              <div className="rounded-lg bg-red-50 p-2 text-red-700">
                <p className="text-lg font-semibold tabular-nums">{summary.absent}</p>
                <p className="text-[11px]">Absent</p>
              </div>
              <div className="rounded-lg bg-amber-50 p-2 text-amber-700">
                <p className="text-lg font-semibold tabular-nums">{summary.leave}</p>
                <p className="text-[11px]">On leave</p>
              </div>
            </div>
            <p className="text-[11px]">
              This is saved against your teacher account with a timestamp. Guardians receive an SMS only for the statuses
              your department policy allows.
            </p>
          </div>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={submit}
      />
    </>
  );
}
