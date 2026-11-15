import { useState } from 'react';
import { api, downloadFile, toast, todayISO, useOnce } from '../lib/api';
import { EmptyState, ErrorBox, Spinner } from '../components/ui';
import { PageHeader } from '../components/AppShell';

interface Catalog {
  reports: Array<{ key: string; title: string }>;
}

interface Result {
  key: string;
  title: string;
  columns: Array<{ key: string; header: string }>;
  rows: Array<Record<string, unknown>>;
  count: number;
}

const RANGE_PRESETS = [
  { label: 'This month', days: new Date().getDate() - 1 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Semester (6 months)', days: 180 },
];

export function ReportsPage() {
  const catalog = useOnce(() => api<Catalog>('/report-catalog'));
  const depts = useOnce(() => api<{ departments: Array<{ id: number; code: string }> }>('/departments'));
  const classes = useOnce(() => api<{ classes: Array<{ id: number; name: string; section: string }> }>('/classes'));
  const [key, setKey] = useState('daily_register');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(todayISO());
  const [deptId, setDeptId] = useState('');
  const [classId, setClassId] = useState('');
  const [threshold, setThreshold] = useState('75');
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  function qs(format = 'json') {
    const p = new URLSearchParams({ from, to, format });
    if (deptId) p.set('department_id', deptId);
    if (classId) p.set('class_id', classId);
    if (key === 'low_attendance') p.set('threshold', threshold);
    return `/reports/${key}?${p.toString()}`;
  }

  async function run() {
    setLoading(true);
    try {
      setResult(await api<Result>(qs()));
      toast.success('Report generated.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not generate the report.');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  async function exportAs(format: 'csv' | 'xlsx' | 'pdf') {
    setExporting(format);
    try {
      const name = await downloadFile(qs(format), `attendease-${key}.${format}`);
      toast.success(`Downloaded ${name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExporting(null);
    }
  }

  return (
    <>
      <PageHeader title="Reports" subtitle="Download any register as CSV, Excel or PDF" />

      <div className="card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label className="label" htmlFor="rk">
              Report
            </label>
            <select id="rk" className="input" value={key} onChange={(e) => setKey(e.target.value)}>
              {(catalog.data?.reports ?? []).map((r) => (
                <option key={r.key} value={r.key}>
                  {r.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rf">
              From
            </label>
            <input id="rf" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="rt">
              To
            </label>
            <input id="rt" type="date" className="input" value={to} max={todayISO()} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="rd">
              Department
            </label>
            <select id="rd" className="input" value={deptId} onChange={(e) => setDeptId(e.target.value)}>
              <option value="">All departments</option>
              {(depts.data?.departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="rc">
              Class
            </label>
            <select id="rc" className="input" value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">All classes</option>
              {(classes.data?.classes ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} • {c.section}
                </option>
              ))}
            </select>
          </div>
          {key === 'low_attendance' && (
            <div>
              <label className="label" htmlFor="th">
                Below %
              </label>
              <input id="th" type="number" min={1} max={100} className="input" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </div>
          )}
          <div className="flex items-end gap-2 lg:col-span-2">
            <button className="btn-primary flex-1" onClick={run} disabled={loading}>
              {loading ? 'Generating…' : 'Generate'}
            </button>
            <button className="btn-ghost" onClick={() => void exportAs('csv')} disabled={Boolean(exporting)}>
              {exporting === 'csv' ? '…' : 'CSV'}
            </button>
            <button className="btn-ghost" onClick={() => void exportAs('xlsx')} disabled={Boolean(exporting)}>
              {exporting === 'xlsx' ? '…' : 'Excel'}
            </button>
            <button className="btn-ghost" onClick={() => void exportAs('pdf')} disabled={Boolean(exporting)}>
              {exporting === 'pdf' ? '…' : 'PDF'}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.label}
              className="chip border hover:bg-[color:var(--surface-2)]"
              style={{ borderColor: 'var(--border)' }}
              onClick={() => {
                const d = new Date();
                d.setDate(d.getDate() - p.days);
                setFrom(d.toISOString().slice(0, 10));
                setTo(todayISO());
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          <h2 className="font-semibold">{result?.title ?? 'Preview'}</h2>
          {result && <span className="text-xs muted">{result.count} rows</span>}
        </div>
        {loading ? (
          <Spinner label="Building report…" />
        ) : !result ? (
          <EmptyState title="Choose a report and press Generate" hint="Exports use the same filters as the preview." />
        ) : !result.rows.length ? (
          <EmptyState title="No data for these filters" hint="Try a wider date range or a different department." />
        ) : (
          <div className="table-wrap max-h-[70vh]">
            <table className="tbl">
              <thead className="sticky top-0 bg-[color:var(--surface)]">
                <tr>
                  {result.columns.map((c) => (
                    <th key={c.key}>{c.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(0, 500).map((r, i) => (
                  <tr key={i}>
                    {result.columns.map((c) => (
                      <td key={c.key} className="whitespace-nowrap">
                        {r[c.key] == null ? '—' : String(r[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {result.rows.length > 500 && (
              <p className="p-3 text-xs muted">Showing first 500 rows — export to get all {result.count}.</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
