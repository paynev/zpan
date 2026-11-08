import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { matters, shares, statsRollupsHourly, storages } from '../../db/schema'
import { type AtomicQuery, executeWriteTransaction } from '../../db/transaction'
import {
  type AdminStatsDimension,
  type AdminStatsMetric,
  assertMetricDimension,
  ADMIN_STATS_DIMENSIONS as D,
  ADMIN_STATS_METRICS as M,
  parseAdminStatsRollupMetadata,
  ROLLUP_VERSION,
} from '../../domain/admin-stats-metrics'
import type { Database } from '../../platform/interface'
import { ADMIN_STATS_FACT_COUNTER_METRICS, buildAdminStatsCounterRowsSqlStatements } from './admin-stats-counter-query'
import { ensureAdminStatsIntegrityOpening, inspectAdminStatsSourceIntegrity } from './admin-stats-integrity'

const HOUR_MS = 3_600_000
const D1_MAX_BOUND_PARAMS = 100
const ROLLUP_BOUND_PARAMS_PER_ROW = 10
export const ADMIN_STATS_ROLLUP_WRITE_BATCH_SIZE = Math.floor(D1_MAX_BOUND_PARAMS / ROLLUP_BOUND_PARAMS_PER_ROW)
const COUNTER_METRICS: AdminStatsMetric[] = [...ADMIN_STATS_FACT_COUNTER_METRICS, M.statsMissingBytes, M.statsRollupRun]
const GAUGE_METRICS: AdminStatsMetric[] = [
  M.backgroundJobSnapshot,
  M.shareInventory,
  M.statsDataQualitySnapshot,
  M.storageInventory,
  M.storageTrashSnapshot,
  M.storageUsed,
  M.userActiveSnapshot,
  M.userInventory,
]
type RollupValue = {
  metric: AdminStatsMetric
  dimensionKey: AdminStatsDimension | ''
  dimensionValue: string
  count: number
  bytes: number
  uniqueCount: number
  lowerBound: boolean
}

type CounterQueryRow = {
  bucketStart: number
  metricKey: string
  dimensionKey: string
  dimensionValue: string
  count: number
  bytes: number
  uniqueCount: number
}

type DimensionValues = Partial<Record<AdminStatsDimension, string | null | undefined>>

export interface AdminStatsHourlyRollupResult {
  bucketStart: Date
  bucketEnd: Date
  rows: number
  lowerBoundRows: number
}

export async function rebuildAdminStatsHour(
  db: Database,
  bucketStartInput: Date,
  generatedAt: Date,
): Promise<AdminStatsHourlyRollupResult> {
  const bucketStart = startOfHour(bucketStartInput)
  if (bucketStart.getTime() !== bucketStartInput.getTime()) throw new Error('stats_bucket_must_align_to_utc_hour')
  const bucketEnd = new Date(bucketStart.getTime() + HOUR_MS)
  const rollups = new RollupAccumulator()
  const capturedSnapshot = await compatibleSnapshotMarker(db, bucketStart)

  const counterRows = (
    await queryStage(
      'counters',
      Promise.all(
        buildAdminStatsCounterRowsSqlStatements({
          fromMs: bucketStart.getTime(),
          toMs: bucketEnd.getTime(),
        }).map((statement) => db.all<CounterQueryRow>(sql.raw(statement))),
      ),
    )
  ).flat()
  for (const row of counterRows) {
    const metric = row.metricKey as AdminStatsMetric
    const dimensionKey = row.dimensionKey as AdminStatsDimension | ''
    if (dimensionKey) assertMetricDimension(metric, dimensionKey)
    rollups.incrementValue(
      metric,
      dimensionKey,
      row.dimensionValue,
      Number(row.count),
      Number(row.bytes),
      Number(row.uniqueCount),
    )
  }
  const lowerBoundRows = 0
  rollups.add(M.statsRollupRun, 1, 0, { outcome: 'success' })
  rollups.incrementValue(M.statsRollupRun, 'metric_key', M.userSignup, 1, 0, 0)
  rollups.incrementValue(M.statsRollupRun, 'metric_key', M.transferDownloadIssued, 1, 0, 0)
  const completionScope = capturedSnapshot ? 'full' : 'counters'
  const counterQuality: 'exact' = 'exact'

  const updatedAt = generatedAt
  const rows = rollups.values().map((row) => ({
    id: rollupId(bucketStart, row),
    bucketStart,
    metricKey: row.metric,
    dimensionKey: row.dimensionKey,
    dimensionValue: row.dimensionValue,
    count: row.count,
    bytes: row.bytes,
    uniqueCount: row.uniqueCount,
    metadata: JSON.stringify(
      row.metric === M.statsRollupRun && row.dimensionKey === ''
        ? {
            version: ROLLUP_VERSION,
            scope: completionScope,
            quality: capturedSnapshot?.quality === 'lower_bound' ? 'lower_bound' : 'exact',
            counterQuality,
            ...(capturedSnapshot
              ? {
                  snapshotQuality: capturedSnapshot.quality,
                  snapshotObservedAt: capturedSnapshot.observedAt,
                }
              : {}),
            generatedAt: generatedAt.toISOString(),
          }
        : {
            version: ROLLUP_VERSION,
            scope: 'counters',
            quality: row.lowerBound ? 'lower_bound' : 'exact',
            generatedAt: generatedAt.toISOString(),
          },
    ),
    updatedAt,
  }))

  const writes: AtomicQuery[] = [
    db
      .delete(statsRollupsHourly)
      .where(
        and(eq(statsRollupsHourly.bucketStart, bucketStart), inArray(statsRollupsHourly.metricKey, COUNTER_METRICS)),
      ),
  ]
  for (let index = 0; index < rows.length; index += ADMIN_STATS_ROLLUP_WRITE_BATCH_SIZE) {
    writes.push(db.insert(statsRollupsHourly).values(rows.slice(index, index + ADMIN_STATS_ROLLUP_WRITE_BATCH_SIZE)))
  }
  await executeWriteTransaction(db, writes)
  return { bucketStart, bucketEnd, rows: rows.length, lowerBoundRows }
}

export async function captureAdminStatsSnapshot(
  db: Database,
  bucketStartInput: Date,
  observedAt: Date,
): Promise<AdminStatsHourlyRollupResult> {
  const bucketStart = startOfHour(bucketStartInput)
  if (bucketStart.getTime() !== bucketStartInput.getTime()) throw new Error('stats_bucket_must_align_to_utc_hour')
  if (startOfHour(observedAt).getTime() !== bucketStart.getTime()) {
    throw new Error('stats_snapshot_must_be_captured_in_bucket')
  }
  const bucketEnd = new Date(bucketStart.getTime() + HOUR_MS)
  const rollups = new RollupAccumulator()
  await ensureAdminStatsIntegrityOpening(db)
  await addSnapshotMetrics(db, rollups, observedAt)
  rollups.add(M.statsRollupRun, 1, 0, { outcome: 'success' })
  const rows = rollups.values().map((row) => ({
    id: rollupId(bucketStart, row),
    bucketStart,
    metricKey: row.metric,
    dimensionKey: row.dimensionKey,
    dimensionValue: row.dimensionValue,
    count: row.count,
    bytes: row.bytes,
    uniqueCount: row.uniqueCount,
    metadata: JSON.stringify({
      version: ROLLUP_VERSION,
      scope: 'snapshots',
      quality: 'exact',
      ...(row.metric === M.statsRollupRun
        ? { snapshotQuality: 'exact', snapshotObservedAt: observedAt.toISOString() }
        : { observedAt: observedAt.toISOString() }),
    }),
    updatedAt: observedAt,
  }))
  const writes: AtomicQuery[] = [
    db
      .delete(statsRollupsHourly)
      .where(
        and(
          eq(statsRollupsHourly.bucketStart, bucketStart),
          or(
            inArray(statsRollupsHourly.metricKey, GAUGE_METRICS),
            and(eq(statsRollupsHourly.metricKey, M.statsRollupRun), ne(statsRollupsHourly.dimensionKey, D.metric)),
          ),
        ),
      ),
  ]
  for (let index = 0; index < rows.length; index += ADMIN_STATS_ROLLUP_WRITE_BATCH_SIZE) {
    writes.push(db.insert(statsRollupsHourly).values(rows.slice(index, index + ADMIN_STATS_ROLLUP_WRITE_BATCH_SIZE)))
  }
  await executeWriteTransaction(db, writes)
  return { bucketStart, bucketEnd, rows: rows.length, lowerBoundRows: 0 }
}

async function compatibleSnapshotMarker(
  db: Database,
  bucketStart: Date,
): Promise<{ quality: 'exact' | 'lower_bound'; observedAt: string } | null> {
  const rows = await db
    .select({ metadata: statsRollupsHourly.metadata })
    .from(statsRollupsHourly)
    .where(
      and(
        eq(statsRollupsHourly.bucketStart, bucketStart),
        eq(statsRollupsHourly.metricKey, M.statsRollupRun),
        eq(statsRollupsHourly.dimensionKey, ''),
        eq(statsRollupsHourly.dimensionValue, ''),
      ),
    )
    .limit(1)
  const metadata = parseAdminStatsRollupMetadata(rows[0]?.metadata ?? null)
  if ((metadata?.scope !== 'snapshots' && metadata?.scope !== 'full') || !metadata.snapshotObservedAt) return null
  return { quality: metadata.snapshotQuality ?? metadata.quality, observedAt: metadata.snapshotObservedAt }
}

export async function hasAdminStatsSnapshot(db: Database, bucketStart: Date): Promise<boolean> {
  return (await compatibleSnapshotMarker(db, bucketStart)) !== null
}

async function addSnapshotMetrics(db: Database, rollups: RollupAccumulator, now: Date): Promise<void> {
  const [
    userRows,
    activeUserRows,
    storageUsedRows,
    inventoryRows,
    inventoryByType,
    inventoryBySize,
    inventoryByAge,
    trashRows,
    shareRows,
    dataQualityRows,
  ] = await Promise.all([
    queryStage('user-inventory', userInventorySnapshot(db, now)),
    queryStage('user-activity', activeUserSnapshot(db, now)),
    queryStage(
      'storage-used',
      db.select({ storageId: storages.id, used: sql<number>`COALESCE(${storages.used}, 0)` }).from(storages),
    ),
    queryStage('inventory-base', inventoryGroups(db, now, 'base')),
    queryStage('inventory-type', inventoryGroups(db, now, 'file_type_group')),
    queryStage('inventory-size', inventoryGroups(db, now, 'size_bucket')),
    queryStage('inventory-age', inventoryGroups(db, now, 'age_bucket')),
    queryStage('trash-inventory', trashInventoryGroups(db)),
    queryStage('shares', shareSnapshotGroups(db, now)),
    queryStage('data-quality', dataQualitySnapshot(db)),
  ])

  rollups.setGauge(M.userInventory, userRows.total, 0)
  rollups.setGauge(M.userInventory, userRows.normal, 0, 'status', 'normal')
  rollups.setGauge(M.userInventory, userRows.verified, 0, 'status', 'verified')
  rollups.setGauge(M.userInventory, userRows.unverified, 0, 'status', 'unverified')
  rollups.setGauge(M.userInventory, userRows.banned, 0, 'status', 'banned')
  rollups.setGauge(M.userInventory, userRows.silent, 0, 'status', 'silent')
  rollups.setGauge(M.userActiveSnapshot, activeUserRows.find((row) => row.window === 'mau')?.count ?? 0, 0)
  for (const row of activeUserRows) rollups.setGauge(M.userActiveSnapshot, row.count, 0, 'window', row.window)
  rollups.setGauge(M.storageUsed, 0, 0)
  rollups.setGauge(M.storageInventory, 0, 0)
  rollups.setGauge(M.storageTrashSnapshot, 0, 0)
  rollups.setGauge(M.shareInventory, 0, 0)
  rollups.setGauge(M.statsDataQualitySnapshot, dataQualityRows.unlocatedShareDownloads, 0)
  rollups.setGauge(M.statsDataQualitySnapshot, dataQualityRows.unlocatedShareDownloads, 0, 'kind', 'share_downloads')
  rollups.setGauge(
    M.statsDataQualitySnapshot,
    dataQualityRows.backgroundJobsMissingFinishedAt,
    0,
    'kind',
    'background_jobs_missing_finished_at',
  )
  rollups.setGauge(M.statsDataQualitySnapshot, dataQualityRows.invalidAuditEvents, 0, 'kind', 'invalid_audit_events')
  rollups.setGauge(
    M.statsDataQualitySnapshot,
    dataQualityRows.missingUserRegistrationEvents,
    0,
    'kind',
    'missing_user_registration_events',
  )
  rollups.setGauge(M.backgroundJobSnapshot, 0, 0)
  for (const row of storageUsedRows) {
    const used = Number(row.used)
    rollups.incrementGauge(M.storageUsed, 0, used)
    rollups.incrementGauge(M.storageUsed, 0, used, 'storage_id', row.storageId)
  }
  for (const row of [...inventoryRows, ...inventoryByType, ...inventoryBySize, ...inventoryByAge]) {
    rollups.incrementGauge(M.storageInventory, row.files, row.bytes, row.dimensionKey, row.dimensionValue)
  }
  for (const row of trashRows) {
    rollups.incrementGauge(M.storageTrashSnapshot, row.files, row.bytes)
    rollups.incrementGauge(M.storageTrashSnapshot, row.files, row.bytes, 'storage_id', row.storageId)
  }
  for (const row of shareRows) {
    rollups.incrementGauge(M.shareInventory, Number(row.count), 0)
    rollups.incrementGauge(M.shareInventory, Number(row.count), 0, 'lifecycle', row.lifecycle)
  }
}

async function shareSnapshotGroups(db: Database, now: Date): Promise<Array<{ lifecycle: string; count: number }>> {
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const lifecycle = sql<string>`CASE
    WHEN ${shares.status} <> 'active' THEN 'revoked'
    WHEN ${shares.expiresAt} IS NOT NULL AND ${shares.expiresAt} <= ${nowSeconds} THEN 'expired'
    WHEN ${shares.downloadLimit} IS NOT NULL AND ${shares.downloads} >= ${shares.downloadLimit} THEN 'download_limit_reached'
    ELSE 'usable'
  END`
  return await db.select({ lifecycle, count: sql<number>`COUNT(*)` }).from(shares).groupBy(lifecycle)
}

async function dataQualitySnapshot(db: Database): Promise<{
  unlocatedShareDownloads: number
  backgroundJobsMissingFinishedAt: number
  invalidAuditEvents: number
  missingUserRegistrationEvents: number
}> {
  const [rows, sourceIntegrity] = await Promise.all([
    db.all<{ unlocatedShareDownloads: number }>(sql`
    WITH share_download_counts AS (
      SELECT json_extract(metadata, '$.shareId') AS share_id, COUNT(*) AS downloads
      FROM audit_events
      WHERE action = 'share_download'
        AND json_valid(metadata) = 1
        AND json_type(metadata, '$.shareId') = 'text'
        AND length(json_extract(metadata, '$.shareId')) > 0
      GROUP BY json_extract(metadata, '$.shareId')
    )
    SELECT COALESCE(SUM(MAX(${shares.downloads} - COALESCE(share_download_counts.downloads, 0), 0)), 0) AS unlocatedShareDownloads
    FROM ${shares}
    LEFT JOIN share_download_counts ON share_download_counts.share_id = ${shares.id}
    `),
    inspectAdminStatsSourceIntegrity(db),
  ])
  const unlocatedShareDownloads = Number(rows[0]?.unlocatedShareDownloads ?? 0)
  return {
    unlocatedShareDownloads,
    backgroundJobsMissingFinishedAt: sourceIntegrity.backgroundJobsMissingFinishedAt,
    invalidAuditEvents: sourceIntegrity.invalidAuditEvents,
    missingUserRegistrationEvents: sourceIntegrity.missingUserRegistrationEvents,
  }
}

async function trashInventoryGroups(db: Database): Promise<Array<{ storageId: string; files: number; bytes: number }>> {
  const rows = await db
    .select({
      storageId: matters.storageId,
      files: sql<number>`COUNT(*)`,
      bytes: sql<number>`COALESCE(SUM(${matters.size}), 0)`,
    })
    .from(matters)
    .where(
      and(
        inArray(matters.status, ['active', 'trashed']),
        sql`${matters.trashedAt} IS NOT NULL`,
        isNull(matters.purgedAt),
        eq(matters.dirtype, 0),
      ),
    )
    .groupBy(matters.storageId)
  return rows.map((row) => ({ ...row, files: Number(row.files), bytes: Number(row.bytes) }))
}

type UserInventorySnapshot = {
  total: number
  normal: number
  unverified: number
  banned: number
  silent: number
  verified: number
}

async function userInventorySnapshot(db: Database, now: Date): Promise<UserInventorySnapshot> {
  const activeCutoffMs = now.getTime() - 30 * 86_400_000
  const rows = await db.all<UserInventorySnapshot>(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN email_verified = 1 THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN email_verified = 0 AND COALESCE(banned, 0) = 0 THEN 1 ELSE 0 END) AS unverified,
      SUM(CASE WHEN COALESCE(banned, 0) = 1 THEN 1 ELSE 0 END) AS banned,
      SUM(CASE WHEN email_verified = 1 AND COALESCE(banned, 0) = 0
        AND (last_active_at IS NULL OR last_active_at < ${activeCutoffMs})
        THEN 1 ELSE 0 END) AS silent
    FROM user
  `)
  const row = rows[0] ?? { total: 0, verified: 0, unverified: 0, banned: 0, silent: 0, normal: 0 }
  const total = Number(row.total)
  const unverified = Number(row.unverified)
  const banned = Number(row.banned)
  const silent = Number(row.silent)
  const verified = Number(row.verified)
  return { total, verified, unverified, banned, silent, normal: Math.max(0, total - unverified - banned - silent) }
}

async function activeUserSnapshot(
  db: Database,
  now: Date,
): Promise<Array<{ window: 'dau' | 'wau' | 'mau'; count: number }>> {
  const windows = [
    { window: 'dau' as const, days: 1 },
    { window: 'wau' as const, days: 7 },
    { window: 'mau' as const, days: 30 },
  ]
  return await Promise.all(
    windows.map(async ({ window, days }) => {
      const cutoffMs = now.getTime() - days * 86_400_000
      const rows = await db.all<{ count: number }>(sql`
        SELECT COUNT(*) AS count
        FROM user
        WHERE last_active_at >= ${cutoffMs}
      `)
      return { window, count: Number(rows[0]?.count ?? 0) }
    }),
  )
}

type InventoryGroup = {
  files: number
  bytes: number
  dimensionKey: AdminStatsDimension | ''
  dimensionValue: string
}

const matterCategorySql = sql<string>`CASE
    WHEN lower(${matters.type}) LIKE 'image/%' THEN 'photos'
    WHEN lower(${matters.type}) LIKE 'video/%' THEN 'videos'
    WHEN lower(${matters.type}) LIKE 'audio/%' THEN 'music'
    WHEN lower(${matters.type}) LIKE 'text/%'
      OR lower(${matters.type}) IN (
        'application/epub+zip', 'application/msword', 'application/pdf', 'application/rtf',
        'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
        'application/vnd.oasis.opendocument.presentation',
        'application/vnd.oasis.opendocument.spreadsheet',
        'application/vnd.oasis.opendocument.text',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) THEN 'documents'
    WHEN lower(${matters.type}) IN (
      'application/gzip', 'application/vnd.rar', 'application/x-7z-compressed',
      'application/x-bzip2', 'application/x-rar-compressed', 'application/x-tar', 'application/zip'
    ) THEN 'archives'
    ELSE 'other'
  END`

async function inventoryGroups(
  db: Database,
  now: Date,
  dimension: '' | 'base' | AdminStatsDimension,
): Promise<InventoryGroup[]> {
  const values = new Map<string, { files: number; bytes: number }>()

  function accumulate(key: string, files: number, bytes: number): void {
    const value = values.get(key) ?? { files: 0, bytes: 0 }
    value.files += files
    value.bytes += bytes
    values.set(key, value)
  }

  if (dimension === 'base' || dimension === 'file_type_group') {
    const matterRows = await db
      .select({
        category: matterCategorySql,
        files: sql<number>`COUNT(*)`,
        bytes: sql<number>`COALESCE(SUM(${matters.size}), 0)`,
      })
      .from(matters)
      .where(
        and(eq(matters.status, 'active'), isNull(matters.trashedAt), isNull(matters.purgedAt), eq(matters.dirtype, 0)),
      )
      .groupBy(matterCategorySql)
    for (const row of matterRows) accumulate(row.category, Number(row.files), Number(row.bytes))

    if (dimension === 'base') {
      const total = [...values.values()].reduce(
        (sum, value) => ({ files: sum.files + value.files, bytes: sum.bytes + value.bytes }),
        { files: 0, bytes: 0 },
      )
      return [{ ...total, dimensionKey: '', dimensionValue: '' }]
    }
    return [...values].map(([dimensionValue, value]) => ({
      ...value,
      dimensionKey: 'file_type_group',
      dimensionValue,
    }))
  }

  const dimensionSql =
    dimension === 'size_bucket'
      ? sql<string>`CASE WHEN ${matters.size} <= ${10 * 1024 * 1024} THEN '<10MB' WHEN ${matters.size} <= ${100 * 1024 * 1024} THEN '10-100MB' WHEN ${matters.size} <= ${1024 * 1024 * 1024} THEN '100MB-1GB' ELSE '>1GB' END`
      : dimension === 'age_bucket'
        ? sql<string>`CASE WHEN ${matters.createdAt} >= ${Math.floor(now.getTime() / 1000) - 30 * 86_400} THEN '<30d' WHEN ${matters.createdAt} >= ${Math.floor(now.getTime() / 1000) - 90 * 86_400} THEN '30-90d' WHEN ${matters.createdAt} >= ${Math.floor(now.getTime() / 1000) - 180 * 86_400} THEN '90-180d' ELSE '>180d' END`
        : sql<string>`''`
  const matterRows = await db
    .select({
      files: sql<number>`COUNT(*)`,
      bytes: sql<number>`COALESCE(SUM(${matters.size}), 0)`,
      dimensionValue: dimensionSql,
    })
    .from(matters)
    .where(
      and(eq(matters.status, 'active'), isNull(matters.trashedAt), isNull(matters.purgedAt), eq(matters.dirtype, 0)),
    )
    .groupBy(dimensionSql)
  const result: InventoryGroup[] = [
    ...matterRows.map((row) => ({
      files: Number(row.files),
      bytes: Number(row.bytes),
      dimensionKey: dimension,
      dimensionValue: row.dimensionValue,
    })),
  ]
  return result
}

class RollupAccumulator {
  private readonly rows = new Map<string, RollupValue>()

  add(metric: AdminStatsMetric, count: number, bytes = 0, dimensions: DimensionValues = {}, lowerBound = false): void {
    this.increment(metric, '', '', count, bytes, 0, lowerBound)
    for (const [dimensionKey, dimensionValue] of Object.entries(dimensions)) {
      if (!dimensionValue) continue
      assertMetricDimension(metric, dimensionKey)
      this.increment(metric, dimensionKey, dimensionValue, count, bytes, 0, lowerBound)
    }
  }

  setGauge(
    metric: AdminStatsMetric,
    count: number,
    bytes: number,
    dimensionKey: AdminStatsDimension | '' = '',
    dimensionValue = '',
  ): void {
    if (dimensionKey) assertMetricDimension(metric, dimensionKey)
    this.rows.set(key(metric, dimensionKey, dimensionValue), {
      metric,
      dimensionKey,
      dimensionValue,
      count,
      bytes,
      uniqueCount: 0,
      lowerBound: false,
    })
  }

  incrementGauge(
    metric: AdminStatsMetric,
    count: number,
    bytes: number,
    dimensionKey: AdminStatsDimension | '' = '',
    dimensionValue = '',
  ): void {
    if (dimensionKey) assertMetricDimension(metric, dimensionKey)
    this.increment(metric, dimensionKey, dimensionValue, count, bytes, 0, false)
  }

  incrementValue(
    metric: AdminStatsMetric,
    dimensionKey: AdminStatsDimension | '',
    dimensionValue: string,
    count: number,
    bytes: number,
    uniqueCount: number,
  ): void {
    this.increment(metric, dimensionKey, dimensionValue, count, bytes, uniqueCount, false)
  }

  values(): RollupValue[] {
    return [...this.rows.values()]
  }

  private increment(
    metric: AdminStatsMetric,
    dimensionKey: AdminStatsDimension | '',
    dimensionValue: string,
    count: number,
    bytes: number,
    uniqueCount: number,
    lowerBound: boolean,
  ): void {
    const rowKey = key(metric, dimensionKey, dimensionValue)
    const row = this.rows.get(rowKey) ?? {
      metric,
      dimensionKey,
      dimensionValue,
      count: 0,
      bytes: 0,
      uniqueCount: 0,
      lowerBound: false,
    }
    row.count += count
    row.bytes += bytes
    row.uniqueCount += uniqueCount
    row.lowerBound ||= lowerBound
    this.rows.set(rowKey, row)
  }
}

function startOfHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS)
}

function key(metric: AdminStatsMetric, dimensionKey: string, dimensionValue: string): string {
  return `${metric}\u0000${dimensionKey}\u0000${dimensionValue}`
}

function rollupId(bucketStart: Date, row: RollupValue): string {
  return `${bucketStart.getTime()}:${row.metric}:${row.dimensionKey || 'all'}:${row.dimensionValue || 'all'}`
}

async function queryStage<T>(name: string, query: PromiseLike<T>): Promise<T> {
  try {
    return await query
  } catch (error) {
    throw new Error(`stats_rollup_query_failed:${name}`, { cause: error })
  }
}
