import { type AdminStatsMetric, ADMIN_STATS_METRICS as M, ROLLUP_VERSION } from '../../domain/admin-stats-metrics'

const HOUR_MS = 3_600_000
const D1_MAX_COMPOUND_SELECT_TERMS = 5

export interface AdminStatsCounterQueryRange {
  fromMs: number | string
  toMs: number | string
  metrics?: readonly AdminStatsMetric[]
}

type HourlySource = {
  metric: AdminStatsMetric
  source: string
  timestampMs: string
  where?: string
  count?: string
  bytes?: string
  uniqueCount?: string
  dimensions?: Record<string, string>
}

const HOURLY_SOURCES: readonly HourlySource[] = [
  {
    metric: M.transferUpload,
    source: `(SELECT
        ae.created_at * 1000 AS occurred_at, ae.action, ae.metadata
      FROM audit_events ae
      WHERE ae.action IN ('upload_confirm', 'upload_failed')
        AND json_valid(ae.metadata) = 1
        AND json_type(ae.metadata, '$.bytes') IN ('integer', 'real')
        AND json_extract(ae.metadata, '$.bytes') >= 0
        AND json_type(ae.metadata, '$.source') = 'text'
        AND length(json_extract(ae.metadata, '$.source')) > 0
      UNION ALL
      SELECT
        ous.updated_at, 'upload_cancel',
        json_object(
          'source', 'upload',
          'storageId', ous.storage_id,
          'reason', 'upload_canceled'
        )
      FROM object_upload_sessions ous
      WHERE ous.status = 'aborted') upload_facts`,
    timestampMs: 'upload_facts.occurred_at',
    bytes:
      "SUM(CASE WHEN upload_facts.action = 'upload_confirm' THEN COALESCE(json_extract(upload_facts.metadata, '$.bytes'), 0) ELSE 0 END)",
    dimensions: {
      source: "COALESCE(json_extract(upload_facts.metadata, '$.source'), 'upload')",
      status:
        "CASE upload_facts.action WHEN 'upload_confirm' THEN 'success' WHEN 'upload_cancel' THEN 'canceled' ELSE 'failed' END",
      reason:
        "CASE WHEN upload_facts.action = 'upload_confirm' THEN NULL ELSE COALESCE(json_extract(upload_facts.metadata, '$.reason'), 'upload_failed') END",
      storage_id: "json_extract(upload_facts.metadata, '$.storageId')",
    },
  },
  {
    metric: M.transferDownloadIssued,
    source: 'audit_events download_issued',
    timestampMs: 'download_issued.created_at * 1000',
    where: `download_issued.action IN ('object_download', 'webdav_download', 'share_download')
      AND json_valid(download_issued.metadata) = 1
      AND json_type(download_issued.metadata, '$.bytes') IN ('integer', 'real')
      AND json_extract(download_issued.metadata, '$.bytes') >= 0
      AND json_type(download_issued.metadata, '$.source') = 'text'
      AND length(json_extract(download_issued.metadata, '$.source')) > 0`,
    bytes: "SUM(COALESCE(json_extract(download_issued.metadata, '$.bytes'), 0))",
    dimensions: {
      source: "COALESCE(json_extract(download_issued.metadata, '$.source'), 'unknown')",
      storage_id: "json_extract(download_issued.metadata, '$.storageId')",
      actor_type:
        "COALESCE(download_issued.actor_type, CASE WHEN download_issued.user_id IS NULL THEN 'anonymous' ELSE 'user' END)",
    },
  },
  {
    metric: M.transferDownloadFailed,
    source: 'audit_events download_failure',
    timestampMs: 'download_failure.created_at * 1000',
    where: `download_failure.action = 'download_failed'
      AND json_valid(download_failure.metadata) = 1
      AND json_type(download_failure.metadata, '$.bytes') IN ('integer', 'real')
      AND json_extract(download_failure.metadata, '$.bytes') >= 0
      AND json_type(download_failure.metadata, '$.source') = 'text'
      AND length(json_extract(download_failure.metadata, '$.source')) > 0`,
    bytes: "SUM(COALESCE(json_extract(download_failure.metadata, '$.bytes'), 0))",
    dimensions: {
      source: "COALESCE(json_extract(download_failure.metadata, '$.source'), 'unknown')",
      reason: "COALESCE(json_extract(download_failure.metadata, '$.reason'), 'unknown')",
    },
  },
  {
    metric: M.shareCreated,
    source: 'shares created_share',
    timestampMs: 'created_share.created_at * 1000',
    dimensions: { kind: 'created_share.kind' },
  },
  {
    metric: M.shareDownloadIssued,
    source: 'audit_events share_download',
    timestampMs: 'share_download.created_at * 1000',
    where: `share_download.action = 'share_download'
      AND json_valid(share_download.metadata) = 1
      AND json_type(share_download.metadata, '$.bytes') IN ('integer', 'real')
      AND json_extract(share_download.metadata, '$.bytes') >= 0
      AND json_type(share_download.metadata, '$.shareId') = 'text'
      AND length(json_extract(share_download.metadata, '$.shareId')) > 0
      AND json_type(share_download.metadata, '$.source') = 'text'
      AND length(json_extract(share_download.metadata, '$.source')) > 0`,
    bytes: "SUM(COALESCE(json_extract(share_download.metadata, '$.bytes'), 0))",
    dimensions: {
      share_id: "json_extract(share_download.metadata, '$.shareId')",
      kind: "CASE WHEN json_extract(share_download.metadata, '$.source') = 'landing_share' THEN 'landing' ELSE 'direct' END",
      source: "json_extract(share_download.metadata, '$.source')",
      actor_type:
        "COALESCE(share_download.actor_type, CASE WHEN share_download.user_id IS NULL THEN 'anonymous' ELSE 'user' END)",
    },
  },
  {
    metric: M.shareSaved,
    source: 'audit_events saved_share',
    timestampMs: 'saved_share.created_at * 1000',
    where: `saved_share.action = 'save_from_share'
      AND json_valid(saved_share.metadata) = 1
      AND json_type(saved_share.metadata, '$.shareId') = 'text'
      AND length(json_extract(saved_share.metadata, '$.shareId')) > 0
      AND json_type(saved_share.metadata, '$.bytes') IN ('integer', 'real')
      AND json_extract(saved_share.metadata, '$.bytes') >= 0`,
    bytes: "SUM(COALESCE(json_extract(saved_share.metadata, '$.bytes'), 0))",
    dimensions: {
      share_id: "json_extract(saved_share.metadata, '$.shareId')",
      actor_type:
        "COALESCE(saved_share.actor_type, CASE WHEN saved_share.user_id IS NULL THEN 'anonymous' ELSE 'user' END)",
    },
  },
  {
    metric: M.userSignup,
    source: 'audit_events registered_user',
    timestampMs: 'registered_user.created_at * 1000',
    where: `registered_user.action = 'user_register'
      AND registered_user.target_id IS NOT NULL
      AND registered_user.user_id = registered_user.target_id
      AND registered_user.event_key = 'event:user_register:' || registered_user.target_id
      AND json_valid(registered_user.metadata) = 1
      AND json_type(registered_user.metadata, '$.provider') = 'text'
      AND length(json_extract(registered_user.metadata, '$.provider')) > 0`,
    dimensions: {
      provider: "json_extract(registered_user.metadata, '$.provider')",
    },
  },
]

export const ADMIN_STATS_FACT_COUNTER_METRICS: readonly AdminStatsMetric[] = [
  ...new Set(HOURLY_SOURCES.map((source) => source.metric)),
]

export function buildAdminStatsCounterRowsSqlStatements(range: AdminStatsCounterQueryRange): string[] {
  return buildCounterSqlStatements(
    range,
    `SELECT
  bucket_start AS bucketStart,
  metric_key AS metricKey,
  dimension_key AS dimensionKey,
  dimension_value AS dimensionValue,
  count,
  bytes,
  unique_count AS uniqueCount
FROM aggregated_rows
ORDER BY bucket_start, metric_key, dimension_key, dimension_value`,
  )
}

export function buildAdminStatsCounterRollupInsertSqlStatements(range: AdminStatsCounterQueryRange): string[] {
  return buildCounterSqlStatements(
    range,
    `INSERT INTO stats_rollups_hourly (
  id, bucket_start, metric_key, dimension_key, dimension_value,
  count, bytes, unique_count, metadata, updated_at
)
SELECT
  CAST(bucket_start AS TEXT) || ':' ||
    metric_key || ':' || COALESCE(NULLIF(dimension_key, ''), 'all') || ':' ||
    COALESCE(NULLIF(hex(dimension_value), ''), 'all'),
  bucket_start, metric_key, dimension_key, dimension_value,
  count, bytes, unique_count,
  json_object('version', ${ROLLUP_VERSION}, 'scope', 'counters', 'quality', 'exact'),
  bucket_start + ${HOUR_MS}
FROM aggregated_rows
WHERE true
ON CONFLICT(bucket_start, metric_key, dimension_key, dimension_value)
DO UPDATE SET
  count = excluded.count,
  bytes = excluded.bytes,
  unique_count = excluded.unique_count,
  metadata = excluded.metadata,
  updated_at = excluded.updated_at
WHERE count <> excluded.count
  OR bytes <> excluded.bytes
  OR unique_count <> excluded.unique_count
  OR metadata <> excluded.metadata
  OR updated_at <> excluded.updated_at`,
  )
}

function buildCounterSqlStatements(range: AdminStatsCounterQueryRange, statement: string): string[] {
  const selectedMetrics = range.metrics ? new Set(range.metrics) : null
  const sources = HOURLY_SOURCES.filter((source) => !selectedMetrics || selectedMetrics.has(source.metric)).map(
    hourlySourceRow,
  )
  const statements: string[] = []
  for (let index = 0; index < sources.length; index += D1_MAX_COMPOUND_SELECT_TERMS) {
    statements.push(buildCounterSql(range, sources.slice(index, index + D1_MAX_COMPOUND_SELECT_TERMS), statement))
  }
  return statements
}

function buildCounterSql(range: AdminStatsCounterQueryRange, sources: string[], statement: string): string {
  return `WITH
bounds AS (
  SELECT (${range.fromMs}) AS from_ms, (${range.toMs}) AS to_ms
),
digits(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
numbers(n) AS (
  SELECT ones.n + tens.n * 10 + hundreds.n * 100 + thousands.n * 1000 + ten_thousands.n * 10000
  FROM digits ones
  CROSS JOIN digits tens
  CROSS JOIN digits hundreds
  CROSS JOIN digits thousands
  CROSS JOIN digits ten_thousands
),
buckets AS (
  SELECT bounds.from_ms + numbers.n * ${HOUR_MS} AS bucket_start
  FROM bounds
  JOIN numbers ON bounds.from_ms + numbers.n * ${HOUR_MS} < bounds.to_ms
),
source_rows AS (
${indent(sources.join('\nUNION ALL\n'), 2)}
),
aggregated_rows AS (
  SELECT
    bucket_start,
    metric_key,
    dimension_key,
    dimension_value,
    SUM(count) AS count,
    SUM(bytes) AS bytes,
    SUM(unique_count) AS unique_count
  FROM source_rows
  GROUP BY bucket_start, metric_key, dimension_key, dimension_value
)
${statement}`
}

function hourlySourceRow(source: HourlySource): string {
  const timestamp = `(${source.timestampMs})`
  const bucket = `CAST(${timestamp} / ${HOUR_MS} AS INTEGER) * ${HOUR_MS}`
  const dimensions = ["'', ''", ...Object.entries(source.dimensions ?? {}).map(([key, value]) => `'${key}', ${value}`)]
    .map((entry) => `      ${entry}`)
    .join(',\n')
  const filters = [
    source.where,
    `${timestamp} >= (SELECT from_ms FROM bounds)`,
    `${timestamp} < (SELECT to_ms FROM bounds)`,
    `(dimension.key = '' OR (dimension.value IS NOT NULL AND CAST(dimension.value AS TEXT) <> ''))`,
  ]
    .filter(Boolean)
    .join('\n    AND ')
  return `SELECT
  ${bucket} AS bucket_start,
  '${source.metric}' AS metric_key,
  dimension.key AS dimension_key,
  CAST(dimension.value AS TEXT) AS dimension_value,
  ${source.count ?? 'COUNT(*)'} AS count,
  ${source.bytes ?? '0'} AS bytes,
  ${source.uniqueCount ?? '0'} AS unique_count
FROM ${source.source}
CROSS JOIN json_each(json_object(
${dimensions}
    )) AS dimension
WHERE ${filters}
GROUP BY 1, 3, 4`
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}
