import { useState } from 'react';
import { api, prettyDate, toast, useOnce } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, ErrorBox, Spinner, StatusPill } from '../components/ui';
import { PageHeader } from '../components/AppShell';

interface Settings {
  driver: string;
  configured: boolean;
  env_hint: string;
  templates: Array<{ code: string; audience: string; body: string; active: boolean }>;
  policies: Array<{ id: number; department_id: number | null; department_code: string | null; audience: string; notify_on: string; recipient: string; enabled: boolean }>;
  stats: Array<{ status: string; n: number }>;
}

export function SmsPage() {
  const { me } = useAuth();
  const settings = useOnce(() => api<Settings>('/sms/settings'));
  const [editing, setEditing] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [sending, setSending] = useState(false);
  const log = useOnce(() => api<{ log: Array<Record<string, string | number | null>>; driver: string }>('/sms/log'), []);

  async function saveTemplate(code: string) {
    try {
      await api(`/sms/templates/${code}`, { method: 'PUT', json: { body } });
      toast.success('Template saved.');
      setEditing(null);
      settings.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save template.');
    }
  }

  async function savePolicy(p: Settings['policies'][number], patch: Partial<Settings['policies'][number]>) {
    try {
      await api('/sms/policies', {
        json: {
          department_id: p.department_id,
          audience: p.audience,
          notify_on: p.notify_on,
          recipient: patch.recipient ?? p.recipient,
          enabled: patch.enabled ?? p.enabled,
        },
      });
      toast.success('Policy updated.');
      settings.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update policy.');
    }
  }

  async function sendTest() {
    setSending(true);
    try {
      const res = await api<{ ok: boolean; result: { status: string; last_error?: string } }>('/sms/test', { json: { phone: testPhone } });
      if (res.ok) toast.success('Test SMS accepted by the gateway.');
      else toast.error(`Not delivered: ${res.result?.last_error ?? res.result?.status}`);
      log.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed.');
    } finally {
      setSending(false);
    }
  }

  if (settings.loading) return <Spinner />;
  if (settings.error) return <ErrorBox message={settings.error} onRetry={settings.reload} />;
  const s = settings.data!;

  return (
    <>
      <PageHeader title="SMS & notifications" subtitle="Gateway status, message templates and who gets notified" />

      <div className={`rounded-xl border p-4 text-sm ${s.configured ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
        <p className="font-semibold">{s.configured ? 'Gateway configured' : 'Gateway credentials not configured'}</p>
        <p className="mt-1">{s.driver}</p>
        <p className="mt-1 text-[12px]">{s.env_hint}</p>
        <p className="mt-2 text-[11px]">
          Messages are queued in the database with an idempotency key and retried with backoff. Without credentials they are
          stored with status <strong>not_sent</strong> — the app never reports a delivery that did not happen.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {['pending', 'sent', 'delivered', 'failed', 'not_sent'].map((k) => {
          const n = s.stats.find((x) => x.status === k)?.n ?? 0;
          return (
            <div key={k} className="card p-3">
              <p className="text-[11px] uppercase tracking-wide muted">{k.replace('_', ' ')}</p>
              <p className="text-xl font-semibold tabular-nums">{n}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="font-semibold">Message templates</h2>
          <p className="text-[11px] muted">Variables: {'{{student_name}} {{roll_no}} {{staff_name}} {{status}} {{subject}} {{date}} {{college_name}}'}</p>
          <div className="mt-3 space-y-3">
            {s.templates.map((t) => (
              <div key={t.code} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium capitalize">{t.audience} attendance</p>
                  {me?.user.role === 'admin' && (
                    <button
                      className="text-xs font-medium text-cyan-700 hover:underline"
                      onClick={() => {
                        setEditing(editing === t.code ? null : t.code);
                        setBody(t.body);
                      }}
                    >
                      {editing === t.code ? 'Cancel' : 'Edit'}
                    </button>
                  )}
                </div>
                {editing === t.code ? (
                  <div className="mt-2">
                    <textarea
                      className="input min-h-[110px]"
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      aria-label={`${t.audience} template body`}
                    />
                    <button className="btn-primary mt-2" onClick={() => void saveTemplate(t.code)}>
                      Save template
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-xs muted leading-relaxed">{t.body}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="font-semibold">Notification policy</h2>
            <p className="text-[11px] muted">College-wide defaults; a department row overrides the default for that trigger.</p>
            <div className="mt-3 table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Dept</th>
                    <th>Audience</th>
                    <th>Notify when</th>
                    <th>Send to</th>
                    <th>On</th>
                  </tr>
                </thead>
                <tbody>
                  {s.policies.map((p) => (
                    <tr key={p.id}>
                      <td>{p.department_code ?? 'All'}</td>
                      <td className="capitalize">{p.audience}</td>
                      <td className="capitalize">{p.notify_on}</td>
                      <td>
                        <select
                          className="input min-h-0 py-1 text-xs"
                          value={p.recipient}
                          disabled={me?.user.role !== 'admin'}
                          onChange={(e) => void savePolicy(p, { recipient: e.target.value })}
                          aria-label="Recipient"
                        >
                          <option value="guardian">Guardian</option>
                          <option value="self">Self</option>
                          <option value="both">Both</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          disabled={me?.user.role !== 'admin'}
                          onChange={(e) => void savePolicy(p, { enabled: e.target.checked })}
                          aria-label="Enabled"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {me?.user.role === 'admin' && (
            <div className="card p-4">
              <h2 className="font-semibold">Send a test SMS</h2>
              <p className="text-[11px] muted">Uses the live gateway. Result is reported exactly as returned.</p>
              <div className="mt-2 flex gap-2">
                <input className="input" placeholder="10-digit mobile number" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} aria-label="Test phone number" inputMode="numeric" />
                <button className="btn-primary" onClick={sendTest} disabled={sending || testPhone.replace(/\D/g, '').length < 10}>
                  {sending ? 'Sending…' : 'Send test'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card mt-4 overflow-hidden">
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
          <h2 className="font-semibold">Delivery log</h2>
          <p className="text-[11px] muted">Numbers are masked. Full numbers are only visible to authorised staff in source records.</p>
        </div>
        {log.loading ? <Spinner /> : !log.data?.log.length ? (
          <EmptyState title="No messages yet" hint="Messages appear here after attendance is submitted under an enabled policy." />
        ) : (
          <div className="table-wrap max-h-[60vh]">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Queued</th>
                  <th>To</th>
                  <th>Audience</th>
                  <th>Attendance</th>
                  <th>SMS status</th>
                  <th>Attempts</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {log.data.log.slice(0, 100).map((r) => (
                  <tr key={String(r.id)}>
                    <td className="whitespace-nowrap">{prettyDate(String(r.created_at))}</td>
                    <td className="tabular-nums">{String(r.to_phone)}</td>
                    <td className="capitalize">{String(r.audience)}</td>
                    <td className="capitalize">{String(r.status_value)}</td>
                    <td>
                      <StatusPill status={String(r.status)} />
                    </td>
                    <td className="tabular-nums">{String(r.attempts)}</td>
                    <td className="max-w-[280px] truncate text-xs muted">{r.last_error ? String(r.last_error) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export function AuditPage() {
  const logs = useOnce(() => api<{ logs: Array<{ id: number; action: string; entity: string; entity_id: string | null; created_at: string; actor: string | null; ip: string | null }> }>('/dashboard/audit?limit=200'));
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every attendance change, correction and configuration update" />
      <div className="card overflow-hidden">
        {logs.loading ? <Spinner /> : logs.error ? <ErrorBox message={logs.error} onRetry={logs.reload} /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {(logs.data?.logs ?? []).map((l) => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap">{new Date(l.created_at).toLocaleString('en-IN')}</td>
                    <td>{l.actor ?? 'system'}</td>
                    <td className="font-medium">{l.action}</td>
                    <td className="muted">
                      {l.entity}
                      {l.entity_id ? ` #${l.entity_id}` : ''}
                    </td>
                    <td className="muted">{l.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
