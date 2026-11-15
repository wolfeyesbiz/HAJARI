import { q } from '../db/index.js';
import type { Request } from 'express';

export interface AuditInput {
  actorUserId: number | null;
  action: string;
  entity: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  req?: Request;
}

/** Append-only audit trail. Never throws into the caller's request path. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await q(
      `INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before_data, after_data, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.actorUserId,
        input.action,
        input.entity,
        input.entityId != null ? String(input.entityId) : null,
        input.before ? JSON.stringify(input.before) : null,
        input.after ? JSON.stringify(input.after) : null,
        input.req?.ip ?? null,
        input.req?.get('user-agent') ?? null,
      ],
    );
  } catch (err) {
    console.error('[audit] failed to write audit log', err);
  }
}
