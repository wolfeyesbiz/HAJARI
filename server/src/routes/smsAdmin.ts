import { Router } from 'express';
import { z } from 'zod';
import { config, smsConfigured, smsDriverLabel } from '../config.js';
import { one, q } from '../db/index.js';
import { ah, badRequest, forbidden, notFound } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { processOutbox } from '../services/sms.js';
import { prettyDate, todayISO } from '../lib/types.js';

export const smsRouter = Router();
smsRouter.use(requireAuth);

smsRouter.get(
  '/settings',
  requireRole('admin', 'hod'),
  ah(async (req, res) => {
    const templates = await q('SELECT code, audience, body, active, updated_at FROM sms_templates ORDER BY code');
    const policies = await q(
      `SELECT p.id, p.department_id, d.code AS department_code, p.audience, p.notify_on, p.recipient, p.enabled
         FROM sms_policies p LEFT JOIN departments d ON d.id=p.department_id
        ORDER BY p.department_id NULLS FIRST, p.audience, p.notify_on`,
    );
    const stats = await q<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM sms_outbox GROUP BY status');
    res.json({
      driver: smsDriverLabel(),
      driver_id: config.sms.driver,
      configured: smsConfigured(),
      templates,
      policies,
      stats,
      env_hint: configuredHint(),
    });
  }),
);

function configuredHint() {
  if (smsConfigured()) return 'Live MSG91 gateway credentials detected on the server.';
  return 'No gateway credentials on the server. Messages are queued and logged with status "not_sent". Set SMS_DRIVER=msg91 plus MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_FLOW_ID and an approved DLT template ID.';
}

smsRouter.put(
  '/templates/:code',
  requireRole('admin'),
  ah(async (req, res) => {
    const code = String(req.params.code);
    const parsed = z.object({ body: z.string().trim().min(10).max(1000), active: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Template body must be at least 10 characters.');
    const before = await one('SELECT code, body, active FROM sms_templates WHERE code=$1', [code]);
    if (!before) throw notFound('Template not found.');
    await q('UPDATE sms_templates SET body=$2, active=COALESCE($3,active), updated_at=now() WHERE code=$1', [
      code,
      parsed.data.body,
      parsed.data.active ?? null,
    ]);
    await audit({ actorUserId: req.user!.id, action: 'sms.template_update', entity: 'sms_templates', entityId: code, before, after: parsed.data, req });
    res.json({ ok: true });
  }),
);

smsRouter.post(
  '/policies',
  requireRole('admin'),
  ah(async (req, res) => {
    const parsed = z
      .object({
        department_id: z.number().int().positive().nullable(),
        audience: z.enum(['student', 'staff']),
        notify_on: z.enum(['present', 'absent', 'leave']),
        recipient: z.enum(['guardian', 'self', 'both']),
        enabled: z.boolean(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('Invalid policy.');
    const d = parsed.data;
    const existing = await one<{ id: number }>(
      'SELECT id FROM sms_policies WHERE COALESCE(department_id,0)=COALESCE($1,0) AND audience=$2 AND notify_on=$3',
      [d.department_id, d.audience, d.notify_on],
    );
    if (existing) {
      await q('UPDATE sms_policies SET recipient=$2, enabled=$3, updated_at=now() WHERE id=$1', [existing.id, d.recipient, d.enabled]);
    } else {
      await q('INSERT INTO sms_policies (department_id, audience, notify_on, recipient, enabled) VALUES ($1,$2,$3,$4,$5)', [
        d.department_id,
        d.audience,
        d.notify_on,
        d.recipient,
        d.enabled,
      ]);
    }
    await audit({ actorUserId: req.user!.id, action: 'sms.policy_update', entity: 'sms_policies', after: d, req });
    res.json({ ok: true });
  }),
);

smsRouter.post(
  '/test',
  requireRole('admin'),
  ah(async (req, res) => {
    const parsed = z.object({ phone: z.string().trim().min(10).max(20), message: z.string().trim().max(300).optional() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Enter a valid mobile number.');
    const body =
      parsed.data.message?.trim() ||
      `AttendEase test message from ${config.college.name} on ${prettyDate(todayISO())}. If you received this, SMS delivery is working.`;
    const row = await one<{ id: number }>(
      `INSERT INTO sms_outbox (idempotency_key, to_phone, recipient_kind, audience, department_id, ref_type, ref_id, status_value, template_code, body)
       VALUES ($1,$2,'test','staff',NULL,'sms_test',0,'test','staff_attendance',$3) RETURNING id`,
      [`test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, parsed.data.phone.replace(/\D/g, ''), body],
    );
    await processOutbox(5);
    const result = await one('SELECT id, status, provider, last_error, attempts FROM sms_outbox WHERE id=$1', [row!.id]);
    await audit({ actorUserId: req.user!.id, action: 'sms.test_send', entity: 'sms_outbox', entityId: row!.id, after: { status: result?.status }, req });
    res.json({ ok: result?.status === 'sent', result });
  }),
);

smsRouter.get(
  '/log',
  ah(async (req, res) => {
    const u = req.user!;
    const status = (req.query.status as string | undefined) || null;
    const dept = u.role === 'admin' ? (req.query.department_id ? Number(req.query.department_id) : null) : u.department_id;
    if (!['admin', 'hod'].includes(u.role) && u.role !== 'teacher') throw forbidden('Not permitted.');
    const rows = await q(
      `SELECT o.id, o.to_phone, o.recipient_kind, o.audience, o.status, o.provider, o.attempts,
              o.last_error, o.created_at, o.sent_at, o.delivered_at, o.body, o.status_value,
              d.code AS department_code
         FROM sms_outbox o LEFT JOIN departments d ON d.id=o.department_id
        WHERE ($1::text IS NULL OR o.status=$1) AND ($2::int IS NULL OR o.department_id=$2)
        ORDER BY o.created_at DESC LIMIT 200`,
      [status, dept],
    );
    // Never expose full phone numbers in bulk listings.
    const masked = rows.map((r) => ({
      ...r,
      to_phone: String(r.to_phone).replace(/^(\d{2})(\d+)(\d{4})$/, (_m, a: string, _b: string, c: string) => `${a}******${c}`),
    }));
    res.json({ log: masked, driver: smsDriverLabel() });
  }),
);

/** Manual drain of the outbox (also runs on an interval worker + retries). */
smsRouter.post(
  '/process',
  requireRole('admin'),
  ah(async (req, res) => {
    const out = await processOutbox(50);
    await audit({ actorUserId: req.user!.id, action: 'sms.process_outbox', entity: 'sms_outbox', after: out, req });
    res.json(out);
  }),
);

/** Gateway delivery-receipt webhook. Verified by a shared secret when configured. */
smsRouter.post(
  '/dlr',
  ah(async (req, res) => {
    const secret = process.env.SMS_DLR_SECRET ?? '';
    if (secret && String(req.query.key ?? req.headers['x-dlr-key'] ?? '') !== secret) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid DLR secret.' } });
    }
    const payload = req.body ?? {};
    const messageId = payload['message-id'] ?? payload.messageId ?? payload.msgid;
    const status = String(payload.status ?? payload.dlr_status ?? '').toLowerCase();
    if (!messageId) return res.status(400).json({ ok: false, error: 'missing message id' });
    const delivered = ['delivered', 'delivrd', '1', 'success'].includes(status);
    const failed = ['failed', 'undelivered', '0', 'rejected'].includes(status);
    if (delivered) {
      await q("UPDATE sms_outbox SET status='delivered', delivered_at=now() WHERE provider_message_id=$1", [String(messageId)]);
    } else if (failed) {
      await q("UPDATE sms_outbox SET status='failed', last_error=COALESCE(last_error,'')||' | DLR: '||$2 WHERE provider_message_id=$1", [
        String(messageId),
        status,
      ]);
    }
    res.json({ ok: true });
  }),
);
