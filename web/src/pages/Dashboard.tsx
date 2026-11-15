import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAuth } from '../lib/auth';
import { api, prettyDate, timeAgo, useOnce } from '../lib/api';
import { EmptyState, ErrorBox, Spinner, StatusPill } from '../components/ui';
import { PageHeader } from '../components/AppShell';

interface Dash {
  role: string;
  today: string;
  totals?: { students: number; staff: number; teaching: number; non_teaching: number };
  day_stats?: Record<string, number>;
  department_stats?: Array<Record<string, number | string>>;
  recent_activity?: Array<Record<string, string | number>>;
  pending_submissions?: Array<{ department_code: string; unmarked_classes: number }>;
  pending_corrections?: number;
  week_trend?: Array<{ date: string; percentage: number }>;
  sms_stats?: Array<{ status: string; n: number }>;
  overview?: { total: number; present: number; percentage: number };
  low_attendance?: Array<{
    student_id: number;
    roll_no: string;
    full_name: string;
    class_name: string;
    section: string;
    total_classes: number;
    attended: number;
    percentage: number;
    low_attendance_count: number;
  }>;
  low_attendance_count?: number;
  by_subject?: Array<{ subject_code: string; subject_name: string; total: number; present: number; percentage: number }>;
  monthly?: Array<{ month: string; total: number; present: number; absent: number }>;
}

function Stat({ label, value, hint, tone = 'navy' }: { label: string; value: string | number; hint?: string; tone?: string }) {
  const tones: Record<string, string> = {
    navy: 'text-navy-800',
    green: 'text-emerald-600',
    red: 'text-red-600',
    amber: 'text-amber-600',
    cyan: 'text-cyan-600',
  };
  return (
    <div className="card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] muted">{hint}</p>}
    </div>
  );
}

export function DashboardPage() {
  const { me } = useAuth();
  const { data, loading, error, reload } = useOnce(() => api<Dash>('/dashboard'));

  if (loading) return <Spinner label="Loading dashboard…" />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return null;

  if (data.role === 'student') {
    const overall = data.overview ?? { total: 0, present: 0, percentage: 0 };
    return (
      <>
        <PageHeader title={`Hello, ${me?.user.full_name.split(' ')[0]}`} subtitle="Your attendance at a glance" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Overall attendance" value={`${overall.percentage ?? 0}%`} tone={Number(overall.percentage) >= 75 ? 'green' : 'red'} />
          <Stat label="Classes attended" value={overall.present ?? 0} />
          <Stat label="Classes held" value={overall.total ?? 0} />
        </div>
        <div className="card mt-4 p-4">
          <h2 className="font-semibold">Subject-wise attendance</h2>
          <div className="mt-3 space-y-3">
            {(data.by_subject ?? []).map((s) => {
              const ok = Number(s.percentage) >= 75;
              return (
                <div key={s.subject_code}>
                  <div className="flex items-center justify-between text-sm">
                    <span>
                      <span className="font-medium">{s.subject_code}</span> <span className="muted">— {s.subject_name}</span>
                    </span>
                    <span className={`tabular-nums font-semibold ${ok ? 'text-emerald-600' : 'text-red-600'}`}>
                      {s.percentage}%
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[color:var(--surface-2)]">
                    <div
                      className={`h-full rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`}
                      style={{ width: `${Math.min(100, Number(s.percentage))}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-[11px] muted">
                    {s.present} of {s.total} classes attended
                  </p>
                </div>
              );
            })}
            {!data.by_subject?.length && <EmptyState title="No attendance recorded yet" />}
          </div>
        </div>
      </>
    );
  }

  if (data.role === 'staff') {
    return (
      <>
        <PageHeader title={`Hello, ${me?.user.full_name.split(' ')[0]}`} subtitle="Your staff attendance by month" />
        <div className="card p-4">
          {(data.monthly ?? []).length ? (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Present</th>
                    <th>Absent</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.monthly ?? []).map((m) => (
                    <tr key={m.month}>
                      <td className="font-medium">{m.month}</td>
                      <td className="text-emerald-600 tabular-nums">{m.present}</td>
                      <td className="text-red-600 tabular-nums">{m.absent}</td>
                      <td className="tabular-nums">{m.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No staff attendance recorded yet" />
          )}
        </div>
      </>
    );
  }

  const ds = data.day_stats ?? {};
  const attendancePct =
    Number(ds.student_present) + Number(ds.student_absent) > 0
      ? Math.round((Number(ds.student_present) / (Number(ds.student_present) + Number(ds.student_absent))) * 1000) / 10
      : 0;

  const pieData = [
    { name: 'Present', value: Number(ds.student_present ?? 0), fill: '#16a34a' },
    { name: 'Absent', value: Number(ds.student_absent ?? 0), fill: '#dc2626' },
    { name: 'On leave', value: Number(ds.student_leave ?? 0), fill: '#d97706' },
  ].filter((d) => d.value > 0);

  const deptData = (data.department_stats ?? []).map((d) => ({
    code: String(d.code),
    present: Number(d.present ?? 0),
    absent: Number(d.absent ?? 0),
  }));

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`${prettyDate(data.today)} • ${me?.user.role === 'admin' ? 'All departments' : me?.user.department_name ?? ''}`}
        actions={
          <>
            <Link to="/attendance/student" className="btn-primary">
              Mark student attendance
            </Link>
            {(me?.user.role === 'admin' || me?.user.role === 'hod') && (
              <Link to="/attendance/staff" className="btn-ghost">
                Staff attendance
              </Link>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Total students" value={data.totals?.students ?? 0} />
        <Stat label="Total staff" value={data.totals?.staff ?? 0} hint={`${data.totals?.teaching ?? 0} teaching`} />
        <Stat label="Students present" value={ds.student_present ?? 0} tone="green" hint="today" />
        <Stat label="Students absent" value={ds.student_absent ?? 0} tone="red" hint="today" />
        <Stat label="Staff present" value={ds.staff_present ?? 0} tone="green" hint={`${ds.staff_absent ?? 0} absent`} />
        <Stat label="Attendance %" value={`${attendancePct}%`} tone={attendancePct >= 75 ? 'cyan' : 'amber'} hint="students today" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Department-wise attendance today</h2>
            <span className="text-[11px] muted">students</span>
          </div>
          <div className="mt-3 h-64">
            {deptData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={deptData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(120,140,170,.22)" vertical={false} />
                  <XAxis dataKey="code" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="present" name="Present" fill="#16a34a" radius={[4, 4, 0, 0]} stackId="a" />
                  <Bar dataKey="absent" name="Absent" fill="#dc2626" radius={[4, 4, 0, 0]} stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState title="No sessions yet today" hint="Mark attendance to see department statistics." />
            )}
          </div>
        </div>

        <div className="card p-4">
          <h2 className="font-semibold">Today’s mix</h2>
          <div className="mt-2 h-48">
            {pieData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
                    {pieData.map((d) => (
                      <Cell key={d.name} fill={d.fill} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState title="Nothing marked yet" />
            )}
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            <li className="flex justify-between">
              <span className="muted">Present</span>
              <span className="font-medium text-emerald-600 tabular-nums">{ds.student_present ?? 0}</span>
            </li>
            <li className="flex justify-between">
              <span className="muted">Absent</span>
              <span className="font-medium text-red-600 tabular-nums">{ds.student_absent ?? 0}</span>
            </li>
            <li className="flex justify-between">
              <span className="muted">On leave</span>
              <span className="font-medium text-amber-600 tabular-nums">{ds.student_leave ?? 0}</span>
            </li>
          </ul>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <h2 className="font-semibold">Recent attendance activity</h2>
          <div className="mt-3 divide-y" style={{ borderColor: 'var(--border)' }}>
            {(data.recent_activity ?? []).map((a) => (
              <div key={String(a.id)} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                <span className="chip border" style={{ borderColor: 'var(--border)' }}>
                  {String(a.department_code)}
                </span>
                <span className="font-medium">{a.kind === 'staff' ? 'Staff' : String(a.class_name)}</span>
                {a.kind === 'student' && <span className="muted">• {String(a.subject_code)} • P{a.period_no}</span>}
                <span className="muted">• {a.taken_by}</span>
                <span className="ml-auto flex items-center gap-2">
                  <StatusPill status={String(a.status)} />
                  <span className="text-[11px] muted">{timeAgo(String(a.submitted_at))}</span>
                </span>
              </div>
            ))}
            {!data.recent_activity?.length && <EmptyState title="No attendance recorded yet" />}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="font-semibold">Pending submissions</h2>
            <p className="text-[11px] muted">Classes with no attendance today</p>
            <ul className="mt-2 space-y-1.5 text-sm">
              {(data.pending_submissions ?? []).map((p) => (
                <li key={p.department_code} className="flex justify-between">
                  <span>{p.department_code}</span>
                  <span className="tabular-nums text-amber-600">{p.unmarked_classes} class(es)</span>
                </li>
              ))}
              {!data.pending_submissions?.length && <li className="text-sm text-emerald-600">All classes marked ✓</li>}
            </ul>
          </div>
          <div className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Low-attendance alerts</h2>
                <p className="mt-1 text-[11px] muted">Overall attendance below 75%</p>
              </div>
              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                Number(data.low_attendance_count ?? 0) > 0
                  ? 'bg-red-50 text-red-700'
                  : 'bg-emerald-50 text-emerald-700'
              }`}>
                {data.low_attendance_count ?? 0}
              </span>
            </div>
            <div className="mt-3 space-y-3">
              {(data.low_attendance ?? []).map((student) => (
                <div key={student.student_id} className="flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{student.full_name}</p>
                    <p className="text-[11px] muted">
                      {student.roll_no} · {student.class_name} {student.section}
                    </p>
                    <p className="text-[11px] muted">
                      {student.attended} of {student.total_classes} classes attended
                    </p>
                  </div>
                  <span className="shrink-0 font-semibold tabular-nums text-red-600">
                    {student.percentage}%
                  </span>
                </div>
              ))}
              {!data.low_attendance?.length && (
                <p className="text-sm text-emerald-600">No students below 75% with recorded attendance.</p>
              )}
              {!!data.low_attendance_count && data.low_attendance_count > (data.low_attendance?.length ?? 0) && (
                <p className="text-[11px] muted">
                  Showing the first {data.low_attendance?.length ?? 0} students. Open Reports for the full list.
                </p>
              )}
            </div>
            <Link to="/reports" className="mt-3 inline-block text-xs font-medium text-cyan-700 hover:underline">
              View attendance reports →
            </Link>
          </div>
          <div className="card p-4">
            <h2 className="font-semibold">Corrections awaiting approval</h2>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{data.pending_corrections ?? 0}</p>
            <Link to="/corrections" className="mt-2 inline-block text-xs font-medium text-cyan-700 hover:underline">
              Review corrections →
            </Link>
          </div>
          <div className="card p-4">
            <h2 className="font-semibold">SMS queue</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {(data.sms_stats ?? []).map((s) => (
                <li key={s.status} className="flex justify-between">
                  <span className="muted capitalize">{s.status.replace('_', ' ')}</span>
                  <span className="tabular-nums">{s.n}</span>
                </li>
              ))}
              {!data.sms_stats?.length && <li className="muted text-sm">Nothing queued yet</li>}
            </ul>
          </div>
        </div>
      </div>

      {!!data.week_trend?.length && (
        <div className="card mt-4 p-4">
          <h2 className="font-semibold">Attendance trend (last 14 days)</h2>
          <div className="mt-3 h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.week_trend.map((d) => ({ ...d, pct: Number(d.percentage) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(120,140,170,.22)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="pct" name="Attendance %" stroke="#0891b2" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </>
  );
}
