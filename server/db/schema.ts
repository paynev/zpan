import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const matters = sqliteTable(
  'matters',
  {
    id: text('id').primaryKey(),
    alias: text('alias').notNull().unique(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    size: integer('size').default(0),
    dirtype: integer('dirtype').default(0),
    parent: text('parent').notNull().default(''),
    object: text('object').notNull().default(''),
    storageId: text('storage_id').notNull(),
    status: text('status').notNull().default('draft'), // draft, active
    trashedAt: integer('trashed_at'), // null = live, epoch ms = in trash (soft delete)
    purgedAt: integer('purged_at'), // null = retained/billable, epoch ms = content permanently removed
    createdByActorType: text('created_by_actor_type'),
    createdByActorRef: text('created_by_actor_ref'),
    createdByActorIssuer: text('created_by_actor_issuer'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('matters_status_dir_created_idx').on(t.status, t.dirtype, t.createdAt),
    index('matters_webdav_path_idx').on(t.parent, t.name, t.status, t.trashedAt, t.purgedAt),
    index('matters_webdav_children_idx').on(
      t.parent,
      t.status,
      t.trashedAt,
      t.purgedAt,
      sql`${t.dirtype} desc`,
      t.name,
    ),
    index('matters_list_page_idx').on(
      t.parent,
      t.status,
      t.trashedAt,
      t.purgedAt,
      sql`${t.dirtype} desc`,
      t.createdAt,
      t.id,
    ),
    index('matters_trash_page_idx').on(t.status, t.purgedAt, t.trashedAt, t.createdAt, t.id),
  ],
)

export const webdavDeadProperties = sqliteTable(
  'webdav_dead_properties',
  {
    id: text('id').primaryKey(),
    resourcePath: text('resource_path').notNull(),
    namespace: text('namespace').notNull(),
    name: text('name').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('webdav_dead_properties_resource_prop_uniq').on(t.resourcePath, t.namespace, t.name),
    index('webdav_dead_properties_resource_idx').on(t.resourcePath),
  ],
)

export const webdavLocks = sqliteTable(
  'webdav_locks',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(), // WebDAV opaquelocktoken URI value
    resourcePath: text('resource_path').notNull(),
    owner: text('owner').notNull().default(''),
    depth: text('depth').notNull().default('infinity'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('webdav_locks_resource_idx').on(t.resourcePath), index('webdav_locks_expires_idx').on(t.expiresAt)],
)

export const storages = sqliteTable('storages', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().default(''),
  bucket: text('bucket').notNull(),
  endpoint: text('endpoint').notNull(),
  region: text('region').notNull().default('auto'),
  accessKey: text('access_key').notNull(),
  secretKey: text('secret_key').notNull(),
  filePath: text('file_path').notNull().default(''),
  capacity: integer('capacity').notNull().default(0),
  forcePathStyle: integer('force_path_style', { mode: 'boolean' }).notNull().default(true),
  used: integer('used').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  status: text('status').notNull().default('unknown'),
  statusReason: text('status_reason'),
  statusCheckedAt: integer('status_checked_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const systemOptions = sqliteTable('system_options', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
})

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    type: text('type').notNull(), // e.g. 'share_received'
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    refType: text('ref_type'), // e.g. 'share'
    refId: text('ref_id'),
    metadata: text('metadata'), // JSON string for extra context
    readAt: integer('read_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_user_read_idx').on(t.userId, t.readAt),
    index('notifications_user_page_idx').on(t.userId, t.readAt, t.createdAt, t.id),
  ],
)

export const objectUploadSessions = sqliteTable(
  'object_upload_sessions',
  {
    id: text('id').primaryKey(),
    objectId: text('object_id').notNull(),
    storageId: text('storage_id').notNull(),
    storageKey: text('storage_key').notNull(),
    uploadId: text('upload_id'), // null for a single-PutObject (≤5 GiB) session; set for multipart
    partSize: integer('part_size').notNull(),
    onConflict: text('on_conflict').notNull().default('fail'), // strategy captured at create, applied at completion
    status: text('status').notNull(),
    createdBy: text('created_by').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('object_upload_sessions_object_idx').on(t.objectId),
    index('object_upload_sessions_expires_idx').on(t.expiresAt),
  ],
)

export const announcements = sqliteTable(
  'announcements',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').notNull().default('draft'),
    priority: integer('priority').notNull().default(0),
    publishedAt: integer('published_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('announcements_status_priority_idx').on(t.status, t.priority),
    index('announcements_published_idx').on(t.publishedAt),
  ],
)

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    eventKey: text('event_key').unique(),
    userId: text('user_id'),
    action: text('action').notNull(), // 'upload', 'create', 'delete', 'rename', 'move', 'restore'
    targetType: text('target_type').notNull(), // 'file', 'folder'
    targetId: text('target_id'),
    targetName: text('target_name').notNull(),
    metadata: text('metadata'), // JSON
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    actorType: text('actor_type'),
    actorRef: text('actor_ref'),
    actorIssuer: text('actor_issuer'),
  },
  (t) => [
    index('audit_events_user_created_idx').on(t.userId, t.createdAt),
    index('audit_events_action_created_idx').on(t.action, t.createdAt),
    index('audit_events_target_created_idx').on(t.targetType, t.targetId, t.createdAt),
    index('audit_events_created_idx').on(t.createdAt),
  ],
)

export const resourceChanges = sqliteTable(
  'resource_changes',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    changeType: text('change_type').notNull(),
    action: text('action'),
    metadata: text('metadata'),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('resource_changes_scope_sequence_idx').on(t.scopeType, t.scopeId, t.sequence),
    index('resource_changes_resource_sequence_idx').on(t.resourceType, t.resourceId, t.sequence),
    index('resource_changes_occurred_idx').on(t.occurredAt),
  ],
)

export const statsRollupsHourly = sqliteTable(
  'stats_rollups_hourly',
  {
    id: text('id').primaryKey(),
    bucketStart: integer('bucket_start', { mode: 'timestamp_ms' }).notNull(),
    metricKey: text('metric_key').notNull(),
    dimensionKey: text('dimension_key').notNull().default(''),
    dimensionValue: text('dimension_value').notNull().default(''),
    count: integer('count').notNull().default(0),
    bytes: integer('bytes').notNull().default(0),
    uniqueCount: integer('unique_count').notNull().default(0),
    metadata: text('metadata'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('stats_rollups_hourly_bucket_metric_dim_uniq').on(
      t.bucketStart,
      t.metricKey,
      t.dimensionKey,
      t.dimensionValue,
    ),
    index('stats_rollups_hourly_metric_bucket_idx').on(t.metricKey, t.bucketStart),
    index('stats_rollups_hourly_dimension_bucket_idx').on(t.metricKey, t.dimensionKey, t.bucketStart),
  ],
)

export const shares = sqliteTable(
  'shares',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    kind: text('kind').notNull(), // 'landing' | 'direct'
    matterId: text('matter_id').notNull(),
    creatorId: text('creator_id').notNull(),
    passwordHash: text('password_hash'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    downloadLimit: integer('download_limit'),
    views: integer('views').notNull().default(0),
    downloads: integer('downloads').notNull().default(0),
    status: text('status').notNull().default('active'), // 'active' | 'revoked'
    private: integer('private', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('shares_creator_status_created_idx').on(t.creatorId, t.status, t.createdAt, t.id),
    index('shares_creator_private_created_idx').on(t.creatorId, t.private, t.createdAt),
    index('shares_created_idx').on(t.createdAt),
  ],
)

export const shareRecipients = sqliteTable(
  'share_recipients',
  {
    id: text('id').primaryKey(),
    shareId: text('share_id').notNull(),
    recipientUserId: text('recipient_user_id'),
    recipientEmail: text('recipient_email'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('share_recipients_share_id_idx').on(t.shareId),
    index('share_recipients_user_id_idx').on(t.recipientUserId),
    index('share_recipients_email_idx').on(t.recipientEmail),
  ],
)
