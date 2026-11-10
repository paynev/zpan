import { generateId } from '../../../shared/ids'
import { auditEvents } from '../../db/schema'
import { assertAuditEvent } from '../../domain/audit-events'
import type { Database } from '../../platform/interface'
import type { AuditRepo, RecordAuditEventInput } from '../../usecases/ports'

export function auditEventValues(event: RecordAuditEventInput): typeof auditEvents.$inferInsert {
  assertAuditEvent(event)
  return {
    id: generateId(),
    userId: event.userId ?? null,
    actorType: event.actorType ?? (event.userId ? 'user' : 'anonymous'),
    actorRef: event.actorRef ?? null,
    actorIssuer: event.actorIssuer ?? null,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    targetName: event.targetName,
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    createdAt: new Date(),
  }
}

// Write-only repo: the single-admin build still records audit events (they feed
// idempotency / transfer activity), but the admin audit-log page and its query
// API were removed, so no read/query methods are exposed here.
export function createAuditRepo(db: Database): AuditRepo {
  return {
    async record(event) {
      await db.insert(auditEvents).values(auditEventValues(event))
    },

    async recordOnce(event, idempotencyKey, occurredAt = new Date()) {
      await db
        .insert(auditEvents)
        .values({
          ...auditEventValues(event),
          eventKey: `event:${event.action}:${idempotencyKey}`,
          createdAt: occurredAt,
        })
        .onConflictDoNothing({ target: auditEvents.eventKey })
    },
  }
}
