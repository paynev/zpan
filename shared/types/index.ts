import type { DirType, ObjectStatus, StorageStatus, StorageStatusReason } from '../constants'
import type { ActorIdentity } from '../schemas/actors'

export interface StorageObject {
  id: string
  alias: string
  name: string
  type: string
  size: number
  dirtype: DirType
  parent: string
  object: string
  storageId: string
  status: ObjectStatus
  // Soft-delete marker: null = live, epoch ms = in trash.
  trashedAt: number | null
  createdBy?: ActorIdentity | null
  createdAt: string
  updatedAt: string
}

export interface ObjectListItem extends StorageObject {
  hasChildren: boolean
}

export interface Storage {
  id: string
  provider: string
  bucket: string
  endpoint: string
  region: string
  accessKey: string
  filePath: string
  capacity: number
  forcePathStyle: boolean
  used: number
  enabled: boolean
  status: StorageStatus
  statusReason: StorageStatusReason | null
  statusCheckedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CursorPage<T> = {
  items: T[]
  nextPageToken: string | null
}

export type PaginatedResponse<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ObjectUploadSession {
  id: string
  objectId: string
  // null for a single-PutObject (≤5 GiB) session; set for S3 multipart.
  uploadId: string | null
  partSize: number
  status: 'active' | 'completed' | 'aborted'
  expiresAt: string
  createdAt: string
  updatedAt: string
}

export interface ObjectUploadPartDescriptor {
  partNumber: number
  url: string
  expiresAt: string
  headers: Record<string, string>
  offset: number
  length: number
}

export interface ObjectUploadWorkflow {
  version: '1'
  upload: {
    method: 'PUT'
    urlField: 'parts[].url'
    headersField: 'parts[].headers'
    fileOffsetField: 'parts[].offset'
    contentLengthField: 'parts[].length'
    etagHeader: 'ETag'
  }
  complete: {
    operationId: 'completeObjectUpload'
    method: 'POST'
    path: string
    partsBodyField: 'parts'
  }
  rePresign: {
    operationId: 'presignObjectUploadParts'
    method: 'POST'
    path: string
    partNumbersBodyField: 'partNumbers'
  }
  abort: {
    operationId: 'abortObjectUpload'
    method: 'DELETE'
    path: string
  }
}

// The upload instructions returned by POST /objects for a file draft: the
// client PUTs each explicit part descriptor directly to S3, reads the ETag of
// each response, then POSTs the partNumber+etag records to .../completions.
export interface ObjectUploadInstructions {
  sessionId: string
  uploadId: string | null
  mode: 'single' | 'multipart'
  partSize: number
  partCount: number
  expiresAt: string
  presignedExpiresAt: string
  requiredHeaders: Record<string, string>
  urls: string[]
  parts: ObjectUploadPartDescriptor[]
  workflow: ObjectUploadWorkflow
}

import type { ShareKind as _ShareKind } from '../schemas/share'

export type { ShareKind } from '../schemas/share'
export type {
  StorageUsageBreakdown,
  StorageUsageCategory,
  StorageUsageItem,
  StorageUsageResponse,
  StorageUsageSortDirection,
  StorageUsageSortField,
} from '../storage-usage'

// passwordHash is intentionally not part of the shared wire type; it never leaves the server.
export interface Share {
  id: string
  token: string
  kind: _ShareKind
  matterId: string
  creatorId: string
  expiresAt: string | null
  downloadLimit: number | null
  views: number
  downloads: number
  status: 'active' | 'revoked'
  private: boolean
  createdAt: string
}

export interface ShareRecipient {
  id: string
  shareId: string
  recipientUserId: string | null
  recipientEmail: string | null
  createdAt: string
}

export interface ShareMatter {
  name: string
  type: string
  dirtype: number
}

export interface ShareListItem extends Share {
  matter: ShareMatter
  recipientCount: number
  // Present on received shares: display name of the user who shared it.
  creatorName?: string
}

export interface ShareView {
  token: string
  kind: _ShareKind
  status: 'active' | 'revoked'
  expiresAt: string | null
  downloadLimit: number | null
  matter: { name: string; type: string; size: number; isFolder: boolean }
  creatorName: string
  requiresPassword: boolean
  expired: boolean
  exhausted: boolean
  accessibleByUser: boolean
  downloads: number
  views: number
  rootRef: string

  id?: string
  matterId?: string
  creatorId?: string
  createdAt?: string
  recipients?: ShareRecipient[]
}

export type NotificationType = 'share_received' | 'archive_job_completed' | 'archive_job_failed'

export interface Notification {
  id: string
  userId: string
  type: NotificationType
  title: string
  body: string
  refType: string | null
  refId: string | null
  metadata: string | null
  readAt: string | null
  createdAt: string
}

export type AuditActorType = 'user' | 'api_key' | 'agent' | 'anonymous' | 'system'

export interface AuditEvent {
  id: string
  userId: string | null
  actorType: AuditActorType
  actorRef: string | null
  actorIssuer: string | null
  action: string
  targetType: string
  targetId: string | null
  targetName: string
  metadata: string | null
  createdAt: string
  user: {
    id: string | null
    name: string
    image: string | null
  }
  actor: {
    name: string
    image: string | null
    resolved: boolean
  }
}

export type { ChangelogInfo, InstanceInfo } from './instance'

export type BrandingThemePresetId = 'default' | 'ocean' | 'forest' | 'rose'

export type BrandingThemeMode = 'preset' | 'custom'

export interface BrandingThemeValues {
  primary_color: string
  primary_foreground: string
  canvas_color: string
  sidebar_accent_color: string
  ring_color: string
}

export interface BrandingThemeConfig {
  mode: BrandingThemeMode
  preset: BrandingThemePresetId
  custom: BrandingThemeValues | null
  configured: boolean
}

export const BRANDING_THEME_PRESETS: Record<BrandingThemePresetId, BrandingThemeValues> = {
  default: {
    primary_color: '#1a73e8',
    primary_foreground: '#ffffff',
    canvas_color: '#f8fafc',
    sidebar_accent_color: '#dbeafe',
    ring_color: '#1a73e8',
  },
  ocean: {
    primary_color: '#007c89',
    primary_foreground: '#ffffff',
    canvas_color: '#effafa',
    sidebar_accent_color: '#cffafe',
    ring_color: '#0891b2',
  },
  forest: {
    primary_color: '#2f6f4e',
    primary_foreground: '#ffffff',
    canvas_color: '#f3f8f2',
    sidebar_accent_color: '#dcfce7',
    ring_color: '#3f8f63',
  },
  rose: {
    primary_color: '#be3455',
    primary_foreground: '#ffffff',
    canvas_color: '#fff5f7',
    sidebar_accent_color: '#ffe4e6',
    ring_color: '#e11d48',
  },
}

export function isBrandingThemePresetId(value: string): value is BrandingThemePresetId {
  return Object.hasOwn(BRANDING_THEME_PRESETS, value)
}

export interface BrandingConfig {
  logo_url: string | null
  favicon_url: string | null
  wordmark_text: string | null
  hide_powered_by: boolean
  theme: BrandingThemeConfig
}

export type BrandingThemeField =
  | 'theme'
  | 'theme_mode'
  | 'theme_preset'
  | 'theme_primary_color'
  | 'theme_primary_foreground'
  | 'theme_canvas_color'
  | 'theme_sidebar_accent_color'
  | 'theme_ring_color'

export type BrandingField = 'logo' | 'favicon' | 'wordmark_text' | 'hide_powered_by' | BrandingThemeField
