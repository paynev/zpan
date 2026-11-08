import { eq, sql } from 'drizzle-orm'
import { auditEvents, systemOptions } from '../../db/schema'
import type { Database } from '../../platform/interface'

const OPENING_SOURCE_ID = 'v3-authoritative-sources'
const OPENING_EVENT_KEY = `audit:statistics_source_initialized:${OPENING_SOURCE_ID}`
const OPENING_OPTION_KEY = 'stats_integrity_exact_from_v3'

export interface AdminStatsSourceIntegrity {
  exactFrom: Date
  backgroundJobsMissingFinishedAt: number
  invalidAuditEvents: number
  missingUserRegistrationEvents: number
}

export async function ensureAdminStatsIntegrityOpening(db: Database, now = new Date()): Promise<Date> {
  const existing = await db
    .select({ value: systemOptions.value })
    .from(systemOptions)
    .where(eq(systemOptions.key, OPENING_OPTION_KEY))
    .limit(1)
  if (existing[0]) return parseOpening(existing[0].value)

  const legacy = await db
    .select({ createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(eq(auditEvents.eventKey, OPENING_EVENT_KEY))
    .limit(1)
  const exactFrom = legacy[0]?.createdAt ?? new Date((Math.floor(now.getTime() / 1000) + 1) * 1000)
  await db
    .insert(systemOptions)
    .values({ key: OPENING_OPTION_KEY, value: exactFrom.toISOString() })
    .onConflictDoNothing({ target: systemOptions.key })
  await db.delete(auditEvents).where(eq(auditEvents.eventKey, OPENING_EVENT_KEY))

  const rows = await db
    .select({ value: systemOptions.value })
    .from(systemOptions)
    .where(eq(systemOptions.key, OPENING_OPTION_KEY))
    .limit(1)
  if (!rows[0]) throw new Error('admin_stats_integrity_opening_missing')
  return parseOpening(rows[0].value)
}

export async function inspectAdminStatsSourceIntegrity(
  db: Database,
  opening?: Date,
): Promise<AdminStatsSourceIntegrity> {
  const exactFrom = opening ?? (await getAdminStatsIntegrityOpening(db))
  if (!exactFrom) throw new Error('admin_stats_integrity_opening_missing')
  const exactFromMs = exactFrom.getTime()
  const exactFromSec = Math.floor(exactFromMs / 1000)
  const rows = await db.all<Omit<AdminStatsSourceIntegrity, 'exactFrom'>>(sql`
    WITH invalid_events AS (
      SELECT COUNT(*) AS count
      FROM audit_events
      WHERE created_at >= ${exactFromSec}
        AND (
          (action = 'upload_confirm' AND (
              json_valid(metadata) = 0
              OR COALESCE(json_type(metadata, '$.bytes') IN ('integer', 'real'), 0) = 0
              OR json_extract(metadata, '$.bytes') < 0
              OR COALESCE(json_type(metadata, '$.source') = 'text', 0) = 0
              OR COALESCE(length(json_extract(metadata, '$.source')), 0) = 0
            ))
          OR (action IN ('upload_failed', 'download_failed') AND (
              json_valid(metadata) = 0
              OR COALESCE(json_type(metadata, '$.bytes') IN ('integer', 'real'), 0) = 0
              OR json_extract(metadata, '$.bytes') < 0
              OR COALESCE(json_type(metadata, '$.source') = 'text', 0) = 0
              OR COALESCE(length(json_extract(metadata, '$.source')), 0) = 0
            ))
          OR (action IN ('object_download', 'webdav_download') AND (
              json_valid(metadata) = 0
              OR COALESCE(json_type(metadata, '$.bytes') IN ('integer', 'real'), 0) = 0
              OR json_extract(metadata, '$.bytes') < 0
              OR COALESCE(json_type(metadata, '$.source') = 'text', 0) = 0
              OR COALESCE(length(json_extract(metadata, '$.source')), 0) = 0
            ))
          OR (action = 'share_download' AND (
              json_valid(metadata) = 0
              OR COALESCE(json_type(metadata, '$.bytes') IN ('integer', 'real'), 0) = 0
              OR json_extract(metadata, '$.bytes') < 0
              OR COALESCE(json_type(metadata, '$.source') = 'text', 0) = 0
              OR COALESCE(length(json_extract(metadata, '$.source')), 0) = 0
              OR COALESCE(json_type(metadata, '$.shareId') = 'text', 0) = 0
              OR COALESCE(length(json_extract(metadata, '$.shareId')), 0) = 0
            ))
          OR (action = 'save_from_share' AND (
              json_valid(metadata) = 0
              OR COALESCE(json_type(metadata, '$.shareId') = 'text', 0) = 0
              OR COALESCE(length(json_extract(metadata, '$.shareId')), 0) = 0
            ))
          OR (action = 'user_register' AND (
              json_valid(metadata) = 0
              OR target_id IS NULL
              OR user_id <> target_id
              OR event_key <> 'event:user_register:' || target_id
              OR COALESCE(json_type(metadata, '$.provider') = 'text', 0) = 0
              OR COALESCE(length(json_extract(metadata, '$.provider')), 0) = 0
            ))
        )
    )
    SELECT
      0 AS backgroundJobsMissingFinishedAt,
      (SELECT count FROM invalid_events) AS invalidAuditEvents,
      (SELECT COUNT(*)
       FROM user registered_user
       WHERE registered_user.created_at >= ${exactFromMs}
         AND NOT EXISTS (
           SELECT 1
           FROM audit_events registration_event
           WHERE registration_event.action = 'user_register'
             AND registration_event.event_key = 'event:user_register:' || registered_user.id
             AND registration_event.user_id = registered_user.id
             AND registration_event.target_id = registered_user.id
             AND registration_event.created_at = CAST(registered_user.created_at / 1000 AS INTEGER)
             AND json_valid(registration_event.metadata) = 1
             AND json_type(registration_event.metadata, '$.provider') = 'text'
             AND length(json_extract(registration_event.metadata, '$.provider')) > 0
         )) AS missingUserRegistrationEvents
  `)

  const row = rows[0]
  return {
    exactFrom,
    backgroundJobsMissingFinishedAt: Number(row?.backgroundJobsMissingFinishedAt ?? 0),
    invalidAuditEvents: Number(row?.invalidAuditEvents ?? 0),
    missingUserRegistrationEvents: Number(row?.missingUserRegistrationEvents ?? 0),
  }
}

export function assertAdminStatsSourceIntegrity(integrity: AdminStatsSourceIntegrity): void {
  const { exactFrom: _, ...counts } = integrity
  if (Object.values(counts).every((count) => count === 0)) return
  console.error(
    JSON.stringify({ event: 'admin_stats_source_integrity_failed', exactFrom: integrity.exactFrom, counts }),
  )
  throw new Error('admin_stats_source_integrity_failed')
}

async function getAdminStatsIntegrityOpening(db: Database): Promise<Date | null> {
  const rows = await db
    .select({ value: systemOptions.value })
    .from(systemOptions)
    .where(eq(systemOptions.key, OPENING_OPTION_KEY))
    .limit(1)
  return rows[0] ? parseOpening(rows[0].value) : null
}

function parseOpening(value: string): Date {
  const opening = new Date(value)
  if (Number.isNaN(opening.getTime())) throw new Error('admin_stats_integrity_opening_invalid')
  return opening
}
