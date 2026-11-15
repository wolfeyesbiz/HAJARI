import { config, smsConfigured } from '../config.js';
import { q } from '../db/index.js';

/**
 * SMS provider adapter.
 *
 * IMPORTANT HONESTY RULE: nothing here ever reports a delivery that did not happen.
 *  - driver "msg91" performs a real HTTPS call to the MSG91 flow API using server-side
 *    credentials. A 2xx response is recorded as `sent` (queued at the gateway) — only a
 *    real DLR webhook moves a message to `delivered` or `failed`.
 *  - driver "log" (default, no credentials) records status `not_sent` with an explicit
 *    reason. It NEVER writes `sent`/`delivered`.
 */

export interface SendResult {
  ok: boolean;
  provider: string;
  providerMessageId?: string;
  status: 'sent' | 'not_sent' | 'failed';
  error?: string;
  retryable: boolean;
}

export function normalizePhone(raw: string): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  // Accept 10-digit Indian mobile numbers or already-prefixed 91XXXXXXXXXX.
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length > 10) return digits;
  return null;
}

function maskPhone(phone: string): string {
  if (phone.length < 4) return '****';
  return `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}

export function maskPhoneForLog(phone: string): string {
  return maskPhone(phone);
}

async function sendViaMsg91(phone: string, body: string, templateCode: string): Promise<SendResult> {
  const cfg = config.sms.msg91;
  const payload = {
    flow_id: cfg.flowId,
    sender: cfg.senderId,
    mobiles: phone,
    // MSG91 flow templates use named variables; we also pass the rendered body as a
    // fallback variable so the template can be authored as {{message}}.
    message: body,
    MESSAGE: body,
    template_code: templateCode,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: cfg.authKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: { type?: string; message?: string | { id?: string }; msgId?: string } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      return {
        ok: false,
        provider: 'msg91',
        status: 'failed',
        error: `MSG91 HTTP ${res.status}: ${text.slice(0, 300)}`,
        retryable,
      };
    }
    const msgId =
      json?.msgId ??
      (typeof json?.message === 'object' ? json?.message?.id : undefined) ??
      undefined;
    return {
      ok: true,
      provider: 'msg91',
      status: 'sent',
      providerMessageId: msgId,
      retryable: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, provider: 'msg91', status: 'failed', error: `network: ${msg}`, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchSms(phone: string, body: string, templateCode: string): Promise<SendResult> {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return { ok: false, provider: 'none', status: 'not_sent', error: 'Invalid or missing phone number', retryable: false };
  }
  if (config.sms.driver === 'msg91' && smsConfigured()) {
    return sendViaMsg91(normalized, body, templateCode);
  }
  return {
    ok: false,
    provider: 'log',
    status: 'not_sent',
    error:
      'No SMS gateway credentials configured. Set SMS_DRIVER=msg91 with MSG91_AUTH_KEY, MSG91_SENDER_ID and MSG91_FLOW_ID (plus an approved DLT template) to enable real delivery.',
    retryable: false,
  };
}

/** Exponential backoff (30s, 60s, 120s…) capped at 30 minutes. */
export function backoffSeconds(attempts: number): number {
  return Math.min(config.sms.retryBaseSeconds * 2 ** Math.max(0, attempts - 1), 1800);
}

/**
 * Processes the outbox. Uses `FOR UPDATE SKIP LOCKED` so concurrent workers never
 * double-send the same row (plus a unique idempotency_key guards enqueue-level dupes).
 */
export async function processOutbox(limit = 25): Promise<{ processed: number; sent: number; failed: number }> {
  const rows = await q<{
    id: number;
    to_phone: string;
    body: string;
    template_code: string;
    attempts: number;
  }>(
    `SELECT id, to_phone, body, template_code, attempts
       FROM sms_outbox
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY created_at
      LIMIT $1`,
    [limit],
  );

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    // Claim the row atomically so a parallel worker cannot pick it up.
    const claimed = await q<{ id: number }>(
      `UPDATE sms_outbox
          SET status = 'pending', attempts = attempts + 1
        WHERE id = $1 AND status = 'pending' AND next_attempt_at <= now()
        RETURNING id`,
      [row.id],
    );
    if (claimed.length === 0) continue;

    const result = await dispatchSms(row.to_phone, row.body, row.template_code);

    if (result.ok) {
      await q(
        `UPDATE sms_outbox
            SET status = 'sent', provider = $2, provider_message_id = $3, sent_at = now(), last_error = NULL
          WHERE id = $1`,
        [row.id, result.provider, result.providerMessageId ?? null],
      );
      sent += 1;
    } else if (result.retryable && row.attempts + 1 < config.sms.maxAttempts) {
      await q(
        `UPDATE sms_outbox
            SET status = 'pending', last_error = $2, provider = $3,
                next_attempt_at = now() + ($4 || ' seconds')::interval
          WHERE id = $1`,
        [row.id, result.error ?? 'unknown error', result.provider, String(backoffSeconds(row.attempts + 1))],
      );
    } else {
      await q(
        `UPDATE sms_outbox
            SET status = CASE WHEN $4 THEN 'failed' ELSE 'not_sent' END,
                last_error = $2, provider = $3
          WHERE id = $1`,
        [row.id, result.error ?? 'unknown error', result.provider, result.status === 'failed'],
      );
      failed += 1;
    }
  }

  return { processed: rows.length, sent, failed };
}

let workerHandle: NodeJS.Timeout | null = null;

export function startOutboxWorker(): void {
  if (!config.sms.workerEnabled || workerHandle) return;
  workerHandle = setInterval(() => {
    processOutbox(25).catch((err) => console.error('[sms] worker error', err));
  }, config.sms.workerIntervalMs);
  workerHandle.unref?.();
}

export function stopOutboxWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
}
