import { config } from '../config.js';
import { one, q } from '../db/index.js';
import { prettyDate } from '../lib/types.js';
import { normalizePhone } from './sms.js';

/**
 * SMS queueing. Runs AFTER the attendance transaction commits so that an SMS/gateway
 * failure can never roll back or lose attendance data.
 *
 * Every message carries a deterministic idempotency key, so re-processing a session
 * (e.g. a duplicate enqueue call or a worker retry) cannot send the same SMS twice.
 */

interface PolicyRow {
  audience: 'student' | 'staff';
  notify_on: string;
  recipient: 'guardian' | 'self' | 'both';
  enabled: boolean;
}

async function policiesFor(audience: 'student' | 'staff', departmentId: number) {
  const rows = await q<PolicyRow>(
    `SELECT audience, notify_on, recipient, enabled FROM sms_policies
      WHERE audience = $1 AND (department_id IS NULL OR department_id = $2)`,
    [audience, departmentId],
  );
  // Department-specific policy overrides the college-wide default for the same trigger.
  const byTrigger = new Map<string, PolicyRow>();
  for (const row of rows) byTrigger.set(row.notify_on, row);
  const deptRows = await q<PolicyRow>(
    `SELECT audience, notify_on, recipient, enabled FROM sms_policies WHERE audience=$1 AND department_id=$2`,
    [audience, departmentId],
  );
  for (const row of deptRows) byTrigger.set(row.notify_on, row);
  return byTrigger;
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '');
}

export interface EnqueueResult {
  queued: number;
  skipped: number;
  reasons: string[];
}

export async function enqueueAttendanceSms(input: { kind: 'student' | 'staff'; sessionId: number }): Promise<EnqueueResult> {
  const result: EnqueueResult = { queued: 0, skipped: 0, reasons: [] };
  try {
    const session = await one<{
      id: number;
      department_id: number;
      session_date: string;
      class_id: number | null;
      subject_id: number | null;
      period_no: number | null;
    }>('SELECT id, department_id, session_date, class_id, subject_id, period_no FROM attendance_sessions WHERE id = $1', [input.sessionId]);
    if (!session) return result;

    if (input.kind === 'student') {
      const templateRow = await one<{ body: string }>("SELECT body FROM sms_templates WHERE code='student_attendance' AND active");
      const subject = session.subject_id
        ? await one<{ name: string }>('SELECT name FROM subjects WHERE id = $1', [session.subject_id])
        : null;
      const policies = await policiesFor('student', Number(session.department_id));

      const records = await q<{
        status: string;
        student_id: number;
        full_name: string;
        roll_no: string;
        guardian_phone: string | null;
        guardian_name: string | null;
        phone: string | null;
      }>(
        `SELECT sa.status, s.id AS student_id, s.full_name, s.roll_no, s.phone,
                COALESCE(pc.phone, s.guardian_phone) AS guardian_phone, pc.name AS guardian_name
           FROM student_attendance sa
           JOIN students s ON s.id = sa.student_id
           LEFT JOIN LATERAL (
             SELECT phone, name FROM parent_contacts p
              WHERE p.student_id = s.id AND p.consent_given ORDER BY p.is_primary DESC, p.id LIMIT 1
           ) pc ON TRUE
          WHERE sa.session_id = $1`,
        [input.sessionId],
      );

      for (const rec of records) {
        const policy = policies.get(rec.status);
        if (!policy || !policy.enabled) {
          result.skipped += 1;
          continue;
        }
        const candidates: { phone: string | null; kind: string }[] = [];
        if (policy.recipient === 'guardian' || policy.recipient === 'both') candidates.push({ phone: rec.guardian_phone, kind: 'guardian' });
        if (policy.recipient === 'self' || policy.recipient === 'both') candidates.push({ phone: rec.phone, kind: 'student' });

        let queuedThisRecord = false;
        for (const cand of candidates) {
          const phone = normalizePhone(cand.phone ?? '');
          if (!phone) continue;
          const body = render(templateRow?.body ?? 'Attendance update for {{student_name}} on {{date}}: {{status}}.', {
            student_name: rec.full_name,
            roll_no: rec.roll_no,
            status: rec.status === 'present' ? 'Present' : rec.status === 'absent' ? 'Absent' : 'On Leave',
            subject: subject?.name ?? 'the session',
            date: prettyDate(session.session_date),
            college_name: config.college.name,
          });
          const key = `student:${input.sessionId}:${rec.student_id}:${policy.notify_on}:${phone}`;
          const inserted = await q(
            `INSERT INTO sms_outbox
               (idempotency_key, to_phone, recipient_kind, audience, student_id, department_id, session_id, ref_type, ref_id, status_value, template_code, body)
             VALUES ($1,$2,$3,'student',$4,$5,$6,'student_attendance',$4,$7,'student_attendance',$8)
             ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
            [key, phone, cand.kind, rec.student_id, session.department_id, input.sessionId, rec.status, body],
          );
          if (inserted.length) {
            result.queued += 1;
            queuedThisRecord = true;
          }
        }
        if (!queuedThisRecord) {
          result.skipped += 1;
          if (rec.status === 'absent' && !rec.guardian_phone && !rec.phone) {
            result.reasons.push(`${rec.roll_no}: no phone number on record`);
          }
        }
      }
    } else {
      const templateRow = await one<{ body: string }>("SELECT body FROM sms_templates WHERE code='staff_attendance' AND active");
      const policies = await policiesFor('staff', Number(session.department_id));
      const records = await q<{ status: string; staff_id: number; full_name: string; phone: string | null }>(
        `SELECT sa.status, sf.id AS staff_id, sf.full_name, sf.phone
           FROM staff_attendance sa JOIN staff sf ON sf.id = sa.staff_id
          WHERE sa.session_id = $1`,
        [input.sessionId],
      );
      for (const rec of records) {
        const policy = policies.get(rec.status);
        if (!policy || !policy.enabled) {
          result.skipped += 1;
          continue;
        }
        const phone = normalizePhone(rec.phone ?? '');
        if (!phone) {
          result.skipped += 1;
          continue;
        }
        const body = render(templateRow?.body ?? 'Dear {{staff_name}}, your attendance for {{date}} is {{status}}.', {
          staff_name: rec.full_name,
          date: prettyDate(session.session_date),
          status: rec.status === 'present' ? 'Present' : rec.status === 'absent' ? 'Absent' : rec.status === 'half_day' ? 'Half Day' : 'On Leave',
          college_name: config.college.name,
        });
        const key = `staff:${input.sessionId}:${rec.staff_id}:${policy.notify_on}:${phone}`;
        const inserted = await q(
          `INSERT INTO sms_outbox
             (idempotency_key, to_phone, recipient_kind, audience, staff_id, department_id, session_id, ref_type, ref_id, status_value, template_code, body)
           VALUES ($1,$2,'self','staff',$3,$4,$5,'staff_attendance',$3,$6,'staff_attendance',$7)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
          [key, phone, rec.staff_id, session.department_id, input.sessionId, rec.status, body],
        );
        if (inserted.length) result.queued += 1;
        else result.skipped += 1;
      }
    }
  } catch (err) {
    console.error('[smsQueue] enqueue failed (attendance is unaffected)', err);
    result.reasons.push('Queueing failed — attendance was saved.');
  }
  return result;
}
