import { useState } from 'react';
import { api, toast, useOnce } from '../lib/api';
import { EmptyState, ErrorBox, Spinner, StatusPill } from '../components/ui';
import { PageHeader } from '../components/AppShell';

function parseStudentCsv(text: string) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('CSV needs a header and at least one student row.');
  const parseRow = (line: string) => {
    const cells: string[] = [];
    let value = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(value.trim()); value = ''; }
      else value += ch;
    }
    cells.push(value.trim());
    return cells;
  };
  const headers = parseRow(lines[0]).map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const index = (names: string[]) => headers.findIndex(h => names.includes(h));
  const roll = index(['roll_no', 'roll', 'usn', 'student_id']);
  const name = index(['full_name', 'name', 'student_name']);
  if (roll < 0 || name < 0) throw new Error('CSV must include roll_no (or roll/USN) and full_name (or name) columns.');
  const optional = { email: index(['email']), phone: index(['phone', 'mobile']), guardian_name: index(['guardian_name', 'parent_name']), guardian_phone: index(['guardian_phone', 'parent_phone']) };
  return lines.slice(1).map((line, rowNo) => {
    const cells = parseRow(line);
    const val = (i: number) => i < 0 ? '' : cells[i] ?? '';
    const record = { roll_no: val(roll), full_name: val(name), email: val(optional.email), phone: val(optional.phone), guardian_name: val(optional.guardian_name), guardian_phone: val(optional.guardian_phone) };
    if (!record.roll_no || !record.full_name) throw new Error(`Row ${rowNo + 2} needs both roll number and name.`);
    return record;
  });
}

type Tab = 'departments' | 'classes' | 'subjects' | 'users' | 'students' | 'staff' | 'assignments';

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('departments');
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'departments', label: 'Departments' },
    { key: 'classes', label: 'Classes' },
    { key: 'subjects', label: 'Subjects' },
    { key: 'users', label: 'Users & teachers' },
    { key: 'students', label: 'Students' },
    { key: 'staff', label: 'Staff' },
    { key: 'assignments', label: 'Assignments' },
  ];

  return (
    <>
      <PageHeader title="Administration" subtitle="Manage departments, people, classes and teaching assignments" />
      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-medium ${
              tab === t.key ? 'bg-navy-800 text-white border-navy-800' : 'bg-[color:var(--surface)]'
            }`}
            style={{ borderColor: tab === t.key ? undefined : 'var(--border)' }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'departments' && <Departments />}
      {tab === 'classes' && <Classes />}
      {tab === 'subjects' && <Subjects />}
      {tab === 'users' && <Users />}
      {tab === 'students' && <Students />}
      {tab === 'staff' && <Staff />}
      {tab === 'assignments' && <Assignments />}
    </>
  );
}

function Departments() {
  const list = useOnce(() => api<{ departments: Array<{ id: number; code: string; name: string; active: boolean; students: number; staff: number; classes: number }> }>('/departments'));
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      await api('/departments', { json: { code, name } });
      toast.success('Department added.');
      setCode('');
      setName('');
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add department.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: number, active: boolean) {
    try {
      await api(`/departments/${id}`, { method: 'PATCH', json: { active: !active } });
      toast.success(active ? 'Department deactivated.' : 'Department activated.');
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update department.');
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="mb-3 font-semibold">Add department</h2>
        <div className="flex flex-wrap gap-2">
          <input className="input max-w-[140px]" placeholder="Code (e.g. IT)" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Department code" />
          <input className="input max-w-xs flex-1" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Department name" />
          <button className="btn-primary" onClick={add} disabled={busy || !code || !name}>
            Add
          </button>
        </div>
      </div>
      <div className="card overflow-hidden">
        {list.loading ? <Spinner /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Classes</th>
                  <th>Students</th>
                  <th>Staff</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(list.data?.departments ?? []).map((d) => (
                  <tr key={d.id}>
                    <td className="font-semibold">{d.code}</td>
                    <td>{d.name}</td>
                    <td className="tabular-nums">{d.classes}</td>
                    <td className="tabular-nums">{d.students}</td>
                    <td className="tabular-nums">{d.staff}</td>
                    <td>{d.active ? <StatusPill status="approved" /> : <StatusPill status="rejected" />}</td>
                    <td className="text-right">
                      <button className="text-xs font-medium text-cyan-700 hover:underline" onClick={() => void toggle(d.id, d.active)}>
                        {d.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Classes() {
  const list = useOnce(() => api<{ classes: Array<{ id: number; name: string; semester: number; section: string; academic_year: string; cycle: string; department_code: string; student_count: number }> }>('/classes'));
  const depts = useOnce(() => api<{ departments: Array<{ id: number; code: string }> }>('/departments'));
  const [deptId, setDeptId] = useState('');
  const [sem, setSem] = useState('3');
  const [section, setSection] = useState('A');
  const [year, setYear] = useState('2026-27');
  const [cycle, setCycle] = useState('standard');

  async function add() {
    try {
      await api('/classes', { json: { department_id: Number(deptId), semester: Number(sem), section, academic_year: year, cycle: Number(sem) <= 2 ? cycle : 'standard' } });
      toast.success('Class added.');
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add class.');
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="mb-3 font-semibold">Add class</h2>
        <div className="flex flex-wrap gap-2">
          <select className="input max-w-[180px]" value={deptId} onChange={(e) => setDeptId(e.target.value)} aria-label="Department">
            <option value="">Department</option>
            {(depts.data?.departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.code}
              </option>
            ))}
          </select>
          <select className="input max-w-[140px]" value={sem} onChange={(e) => setSem(e.target.value)} aria-label="Semester">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
              <option key={s} value={s}>
                Semester {s}
              </option>
            ))}
          </select>
          <input className="input max-w-[90px]" value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section" />
          <input className="input max-w-[120px]" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Academic year" placeholder="2026-27" />
          {Number(sem) <= 2 && <select className="input max-w-[170px]" value={cycle} onChange={(e) => setCycle(e.target.value)} aria-label="First-year cycle"><option value="chemistry">Chemistry cycle</option><option value="physics">Physics cycle</option></select>}
          <button className="btn-primary" onClick={add} disabled={!deptId}>
            Add class
          </button>
        </div>
      </div>
      <div className="card overflow-hidden">
        {list.loading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Dept</th>
                  <th>Semester</th>
                  <th>Year</th>
                  <th>Cycle</th>
                  <th>Section</th>
                  <th>Students</th>
                </tr>
              </thead>
              <tbody>
                {(list.data?.classes ?? []).map((c) => (
                  <tr key={c.id}>
                    <td className="font-medium">{c.name}</td>
                    <td>{c.department_code}</td>
                    <td>{c.semester}</td>
                    <td>{c.academic_year}</td>
                    <td className="capitalize">{c.cycle === 'standard' ? '—' : `${c.cycle} cycle`}</td>
                    <td>{c.section}</td>
                    <td className="tabular-nums">{c.student_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Subjects() {
  const list = useOnce(() => api<{ subjects: Array<{ id: number; code: string; name: string; semester: number; department_code: string }> }>('/subjects'));
  return (
    <div className="card overflow-hidden">
      {list.loading ? <Spinner /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Code</th>
                <th>Subject</th>
                <th>Dept</th>
                <th>Semester</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.subjects ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="font-medium">{s.code}</td>
                  <td>{s.name}</td>
                  <td>{s.department_code}</td>
                  <td>{s.semester}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Users() {
  const list = useOnce(() => api<{ users: Array<{ id: number; full_name: string; email: string; role: string; status: string; department_code: string | null; last_login_at: string | null }> }>('/people/users'));
  const depts = useOnce(() => api<{ departments: Array<{ id: number; code: string }> }>('/departments'));
  const [form, setForm] = useState({ full_name: '', email: '', password: '', role: 'teacher', department_id: '' });

  async function add() {
    try {
      await api('/people/users', {
        json: {
          full_name: form.full_name,
          email: form.email,
          password: form.password,
          role: form.role,
          department_id: form.department_id ? Number(form.department_id) : null,
        },
      });
      toast.success('Account created.');
      setForm({ full_name: '', email: '', password: '', role: 'teacher', department_id: '' });
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the account.');
    }
  }

  async function toggle(id: number, status: string) {
    try {
      await api(`/people/users/${id}/status`, { method: 'PATCH', json: { status: status === 'active' ? 'inactive' : 'active' } });
      toast.success('Account updated.');
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the account.');
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="mb-3 font-semibold">Create teacher / HOD account</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <input className="input" placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} aria-label="Full name" />
          <input className="input" placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-label="Email" />
          <input className="input" placeholder="Temp password (8+ chars)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} aria-label="Password" />
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} aria-label="Role">
            <option value="teacher">Teacher</option>
            <option value="hod">HOD</option>
            <option value="admin">Administrator</option>
          </select>
          <select className="input" value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })} aria-label="Department">
            <option value="">No department</option>
            {(depts.data?.departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.code}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-primary mt-3" onClick={add} disabled={!form.full_name || !form.email || form.password.length < 8}>
          Create account
        </button>
      </div>
      <div className="card overflow-hidden">
        {list.loading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Dept</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(list.data?.users ?? []).map((u) => (
                  <tr key={u.id}>
                    <td className="font-medium">{u.full_name}</td>
                    <td className="muted">{u.email}</td>
                    <td className="capitalize">{u.role}</td>
                    <td>{u.department_code ?? '—'}</td>
                    <td>{u.status === 'active' ? <StatusPill status="approved" /> : <StatusPill status="rejected" />}</td>
                    <td className="text-right">
                      <button className="text-xs font-medium text-cyan-700 hover:underline" onClick={() => void toggle(u.id, u.status)}>
                        {u.status === 'active' ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Students() {
  const [search, setSearch] = useState('');
  const [classId, setClassId] = useState('');
  const [uploading, setUploading] = useState(false);
  const classes = useOnce(() => api<{ classes: Array<{ id: number; name: string; section: string; semester: number; academic_year: string; cycle: string }> }>('/classes'));
  const list = useOnce(() => api<{ students: Array<Record<string, string | number | boolean | null>> }>(`/people/students?q=${encodeURIComponent(search)}`), [search]);
  async function importCsv(file?: File) {
    if (!file || !classId) return;
    try {
      setUploading(true);
      const rows = parseStudentCsv(await file.text());
      const result = await api<{ imported: number }>('/people/students/import', { json: { class_id: Number(classId), students: rows } });
      toast.success(`${result.imported} students imported. Demo students for this class were replaced.`);
      list.reload();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not import this CSV.'); }
    finally { setUploading(false); }
  }
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center gap-2 p-4">
        <div className="min-w-[220px] flex-1"><h2 className="font-semibold">Import student CSV</h2><p className="muted text-xs">Required columns: roll_no, full_name. Optional: email, phone, guardian_name, guardian_phone. Demo rows in this class will be replaced.</p></div>
        <select className="input max-w-xs" value={classId} onChange={e => setClassId(e.target.value)} aria-label="Class for student import"><option value="">Choose class</option>{(classes.data?.classes ?? []).map(c => <option key={c.id} value={c.id}>{c.name} • Sec {c.section} • Sem {c.semester} • {c.academic_year}{c.cycle !== 'standard' ? ` • ${c.cycle} cycle` : ''}</option>)}</select>
        <label className={`btn-primary cursor-pointer ${!classId || uploading ? 'pointer-events-none opacity-50' : ''}`}> {uploading ? 'Importing…' : 'Choose CSV'}<input className="sr-only" type="file" accept=".csv,text/csv" disabled={!classId || uploading} onChange={e => { void importCsv(e.target.files?.[0]); e.currentTarget.value = ''; }} /></label>
      </div>
      <input className="input max-w-sm" placeholder="Search students" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search students" />
      <div className="card overflow-hidden">
        {list.loading ? <Spinner /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Roll</th>
                  <th>Name</th>
                  <th>Class</th>
                  <th>Guardian phone</th>
                  <th>Demo</th>
                </tr>
              </thead>
              <tbody>
                {(list.data?.students ?? []).slice(0, 200).map((s) => (
                  <tr key={String(s.id)}>
                    <td className="tabular-nums">{String(s.roll_no)}</td>
                    <td className="font-medium">{String(s.full_name)}</td>
                    <td>
                      {String(s.class_name)} • {String(s.section)}
                    </td>
                    <td className="tabular-nums">{s.guardian_phone ? String(s.guardian_phone) : '—'}</td>
                    <td>{s.is_demo ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Staff() {
  const list = useOnce(() => api<{ staff: Array<Record<string, string | number | boolean | null>> }>('/people/staff'));
  return (
    <div className="card overflow-hidden">
      {list.loading ? <Spinner /> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Designation</th>
                <th>Dept</th>
                <th>Type</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.staff ?? []).map((s) => (
                <tr key={String(s.id)}>
                  <td className="tabular-nums">{String(s.staff_code)}</td>
                  <td className="font-medium">{String(s.full_name)}</td>
                  <td>{String(s.designation)}</td>
                  <td>{String(s.department_code)}</td>
                  <td className="capitalize">{String(s.employment_type).replace('_', ' ')}</td>
                  <td className="tabular-nums">{s.phone ? String(s.phone) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Assignments() {
  const list = useOnce(() => api<{ assignments: Array<Record<string, string | number>> }>('/assignments'));
  const teachers = useOnce(() => api<{ users: Array<{ id: number; full_name: string; role: string }> }>('/people/users'));
  const classes = useOnce(() => api<{ classes: Array<{ id: number; name: string; section: string }> }>('/classes'));
  const subjects = useOnce(() => api<{ subjects: Array<{ id: number; code: string; name: string }> }>('/subjects'));
  const [f, setF] = useState({ teacher: '', class_id: '', subject_id: '' });

  async function add() {
    try {
      await api('/assignments', { json: { teacher_user_id: Number(f.teacher), class_id: Number(f.class_id), subject_id: Number(f.subject_id) } });
      toast.success('Assignment added.');
      setF({ teacher: '', class_id: '', subject_id: '' });
      list.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add assignment.');
    }
  }

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <h2 className="mb-3 font-semibold">Assign a teacher to a class + subject</h2>
        <div className="grid gap-2 sm:grid-cols-4">
          <select className="input" value={f.teacher} onChange={(e) => setF({ ...f, teacher: e.target.value })} aria-label="Teacher">
            <option value="">Teacher</option>
            {(teachers.data?.users ?? []).filter((u) => u.role === 'teacher').map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
          <select className="input" value={f.class_id} onChange={(e) => setF({ ...f, class_id: e.target.value })} aria-label="Class">
            <option value="">Class</option>
            {(classes.data?.classes ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} • {c.section}
              </option>
            ))}
          </select>
          <select className="input" value={f.subject_id} onChange={(e) => setF({ ...f, subject_id: e.target.value })} aria-label="Subject">
            <option value="">Subject</option>
            {(subjects.data?.subjects ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}
              </option>
            ))}
          </select>
          <button className="btn-primary" onClick={add} disabled={!f.teacher || !f.class_id || !f.subject_id}>
            Assign
          </button>
        </div>
      </div>
      <div className="card overflow-hidden">
        {list.loading ? <Spinner /> : !list.data?.assignments.length ? <EmptyState title="No assignments yet" /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Teacher</th>
                  <th>Class</th>
                  <th>Subject</th>
                  <th>Dept</th>
                </tr>
              </thead>
              <tbody>
                {list.data.assignments.map((a, i) => (
                  <tr key={i}>
                    <td className="font-medium">{String(a.teacher_name)}</td>
                    <td>
                      {String(a.class_name)} • {String(a.section)}
                    </td>
                    <td>
                      {String(a.subject_code)} — {String(a.subject_name)}
                    </td>
                    <td>{String(a.department_code)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
