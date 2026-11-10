import type { ApiKeyMetadata } from '@shared/api-key-templates'
import type {
  ActorProfile,
  CompleteObjectUploadInput,
  ConflictStrategy,
  CreateShareRequest,
  CreateStorageInput,
  PatchStorageInput,
  PresignObjectUploadPartsInput,
  ReplaceStorageInput,
  ShareObjectItem,
  ShareObjectsResponse,
  ShareReadmeResponse,
  SiteConfig,
  SiteSettings,
  UpdateSiteIdentityInput,
  UpdateSiteWebDavInput,
} from '@shared/schemas'
import type {
  BrandingConfig,
  BrandingField,
  BrandingThemeMode,
  BrandingThemePresetId,
  BrandingThemeValues,
  ChangelogInfo,
  CursorPage,
  InstanceInfo,
  Notification,
  ObjectListItem,
  ObjectUploadInstructions,
  ShareListItem,
  ShareView,
  Storage,
  StorageObject,
} from '@shared/types'
import {
  authedSharesApi,
  brandingAdminApi,
  configzApi,
  eventsUrlApi,
  notificationsApi,
  objects,
  publicSharesApi,
  siteSettingsApi,
  storages,
  system,
  trash,
} from './rpc'

export type { Storage, StorageObject }

export function getSiteConfig() {
  return unwrap<SiteConfig>(configzApi.index.$get())
}

export function getSiteSettings() {
  return unwrap<SiteSettings>(siteSettingsApi.index.$get())
}

export function updateSiteIdentity(input: UpdateSiteIdentityInput) {
  return unwrap<SiteSettings['identity']>(siteSettingsApi.identity.$put({ json: input }))
}

export function updateSiteWebDav(input: UpdateSiteWebDavInput) {
  return unwrap<SiteSettings['webdav']>(siteSettingsApi.webdav.$put({ json: input }))
}

export function verifySiteWebDav() {
  return unwrap<SiteSettings['webdav']>(siteSettingsApi.webdav.verifications.$post())
}

export interface ErrorInfo {
  reason: string
  domain: string
  metadata?: Record<string, string>
}

export interface ApiErrorBody {
  error: {
    code: number
    message: string
    status: string
    details?: ErrorInfo[]
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody
  readonly reason: string | undefined
  readonly metadata: Record<string, string> | undefined
  readonly canonicalStatus: string | undefined
  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.reason = body.error.details?.[0]?.reason
    this.metadata = body.error.details?.[0]?.metadata
    this.canonicalStatus = body.error.status
  }
}

// Normalizes any error payload into the AIP-193 `google.rpc.Status` body the
// server now returns. Real server errors pass through; network failures,
// non-JSON responses, and external (S3) fallbacks are wrapped synthetically.
// Flat payloads shaped `{ error: <code>, message?, hint? }` (e.g. the Worker's
// `instance_not_configured` 503) keep their human message and setup hint.
function toErrorBody(status: number, raw: unknown): ApiErrorBody {
  if (raw && typeof raw === 'object' && 'error' in raw) {
    const error = (raw as { error: unknown }).error
    if (error && typeof error === 'object') return raw as ApiErrorBody
    if (typeof error === 'string') {
      const flat = raw as { message?: unknown; hint?: unknown }
      const message = typeof flat.message === 'string' && flat.message ? flat.message : error
      const hint = typeof flat.hint === 'string' && flat.hint ? flat.hint : undefined
      return {
        error: {
          code: status,
          message,
          status: '',
          details: hint ? [{ reason: error, domain: 'instance', metadata: { hint } }] : [],
        },
      }
    }
    return {
      error: { code: status, message: `HTTP ${status}`, status: '', details: [] },
    }
  }
  return {
    error: { code: status, message: `HTTP ${status}`, status: '', details: [] },
  }
}

const SESSION_REQUEST_TIMEOUT_MS = 10_000

export function isNameConflictError(
  err: unknown,
): err is ApiError & { metadata: { conflictingName: string; conflictingId: string } } {
  return err instanceof ApiError && err.status === 409 && err.reason === 'NAME_CONFLICT'
}

async function unwrap<T>(promise: Promise<Response>): Promise<T> {
  const res = await promise
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}))
    throw new ApiError(res.status, toErrorBody(res.status, parsed))
  }
  return res.json() as Promise<T>
}

// Counterpart to unwrap for 204 No Content responses: validate, return nothing.
async function discard(promise: Promise<Response>): Promise<void> {
  const res = await promise
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}))
    throw new ApiError(res.status, toErrorBody(res.status, parsed))
  }
}

// Objects API — lists live objects only (the recycle bin is listTrash).

export function listObjectsByPath(
  path: string,
  pageToken: string | undefined = undefined,
  pageSize = 100,
  opts?: { type?: string; search?: string },
) {
  const query: Record<string, string> = { path, pageSize: String(pageSize) }
  if (pageToken) query.pageToken = pageToken
  if (opts?.type) query.type = opts.type
  if (opts?.search) query.search = opts.search
  return unwrap<CursorPage<ObjectListItem>>(objects.index.$get({ query }))
}

export function getObject(id: string) {
  return unwrap<StorageObject & { downloadUrl?: string }>(objects[':id'].$get({ param: { id } }))
}

export function getObjectCreator(id: string) {
  return unwrap<ActorProfile>(objects[':id'].creator.$get({ param: { id } }))
}

// POST /api/objects returns a folder, or a file draft with `upload` instructions:
// the server-decided part size and one presigned PUT URL per slice.
export interface CreateObjectResult extends StorageObject {
  upload?: ObjectUploadInstructions
}

export function createObject(data: {
  name: string
  type?: string
  size?: number
  parent: string
  dirtype: number
  onConflict?: ConflictStrategy
  storageId?: string
}) {
  return unwrap<CreateObjectResult>(objects.index.$post({ json: data }))
}

export function updateObject(id: string, data: { name?: string; parent?: string; onConflict?: ConflictStrategy }) {
  return unwrap<StorageObject>(objects[':id'].$patch({ param: { id }, json: data }))
}

// Finalize an upload (draft → live): the client has PUT every slice and read each
// ETag. Returns the live object.
export function completeObjectUpload(id: string, uploadSessionId: string, parts: CompleteObjectUploadInput['parts']) {
  return unwrap<StorageObject>(
    objects[':id'].uploads[':uploadSessionId'].completions.$post({ param: { id, uploadSessionId }, json: { parts } }),
  )
}

// Abort an in-progress upload and discard the draft.
export function abortObjectUpload(id: string, uploadSessionId: string, opts: { strictStorageCleanup?: boolean } = {}) {
  return discard(
    objects[':id'].uploads[':uploadSessionId'].$delete({
      param: { id, uploadSessionId },
      query: opts.strictStorageCleanup ? { strictStorageCleanup: '1' } : {},
    }),
  )
}

// Re-presign expired part URLs mid-upload (multipart only); the happy path uses
// the URLs from createObject.
export function presignObjectUploadParts(id: string, uploadSessionId: string, data: PresignObjectUploadPartsInput) {
  return unwrap<{
    uploadId: string | null
    mode: 'multipart'
    partSize: number
    partCount: number
    presignedExpiresAt: string
    requiredHeaders: Record<string, string>
    parts: ObjectUploadInstructions['parts']
  }>(
    objects[':id'].uploads[':uploadSessionId'].parts.$post({
      param: { id, uploadSessionId },
      json: data,
    }),
  )
}

// Soft delete: move a live object to trash (DELETE /api/objects/:id → 204).
export function deleteObject(id: string) {
  return discard(objects[':id'].$delete({ param: { id } }))
}

export function copyObject(id: string, parent: string, onConflict?: ConflictStrategy) {
  return unwrap<StorageObject>(objects[':id'].copies.$post({ param: { id }, json: { parent, onConflict } }))
}

// ── Trash (the /objects grouping for trashed items) ──────────────────────────

// Lists trashed objects, roots only (a trashed folder is one entry).
export function listTrash(opts: { pageToken?: string; pageSize?: number } = {}) {
  return unwrap<CursorPage<StorageObject>>(
    trash.objects.$get({
      query: {
        pageSize: String(opts.pageSize ?? 20),
        ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
      },
    }),
  )
}

export function getTrashObject(id: string) {
  return unwrap<StorageObject>(trash.objects[':id'].$get({ param: { id } }))
}

export function restoreObject(id: string, onConflict?: ConflictStrategy) {
  return unwrap<StorageObject>(trash.objects[':id'].restorations.$post({ param: { id }, json: { onConflict } }))
}

// Permanently delete one trashed root (recursive subtree purge, DELETE → 204).
export function purgeTrashObject(id: string) {
  return discard(trash.objects[':id'].$delete({ param: { id } }))
}

// Unified server-sent events stream consumed by the authenticated application shell.
export function serverEventsUrl() {
  return eventsUrlApi.index.$url()
}

// Admin Storages API

export function listStorages() {
  return unwrap<{ items: Storage[]; total: number }>(storages.index.$get())
}

export function createStorage(data: CreateStorageInput) {
  return unwrap<Storage>(storages.index.$post({ json: data }))
}

export function getStorage(id: string) {
  return unwrap<Storage>(storages[':id'].$get({ param: { id } }))
}

export function replaceStorage(id: string, data: ReplaceStorageInput) {
  return unwrap<Storage>(storages[':id'].$put({ param: { id }, json: data }))
}

export function patchStorage(id: string, data: PatchStorageInput) {
  return unwrap<Storage>(storages[':id'].$patch({ param: { id }, json: data }))
}

export function deleteStorage(id: string) {
  return discard(storages[':id'].$delete({ param: { id } }))
}

// Notifications API

export type NotificationListResult = {
  items: Notification[]
  nextPageToken: string | null
}

export function listNotifications(opts: { pageToken?: string; pageSize?: number; unreadOnly?: boolean } = {}) {
  return unwrap<NotificationListResult>(
    notificationsApi.index.$get({
      query: {
        pageSize: String(opts.pageSize ?? 20),
        unread: String(opts.unreadOnly ?? false),
        ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
      },
    }),
  )
}

export function getUnreadCount() {
  return unwrap<{ count: number }>(notificationsApi.stats.$get())
}

export function markNotificationRead(id: string) {
  return notificationsApi[':id'].$patch({ param: { id } }).then((res) => {
    if (!res.ok) throw new ApiError(res.status, toErrorBody(res.status, { error: res.statusText }))
  })
}

export function markAllNotificationsRead() {
  return unwrap<{ count: number }>(notificationsApi.index.$patch())
}

// Shares API

export type { ShareListItem, ShareView }

export function listShares(pageToken?: string, pageSize = 20, status?: 'active' | 'revoked') {
  const query: Record<string, string> = { pageSize: String(pageSize) }
  if (pageToken) query.pageToken = pageToken
  if (status) query.status = status
  return unwrap<CursorPage<ShareListItem>>(authedSharesApi.index.$get({ query }))
}

export function listReceivedShares(pageToken?: string, pageSize = 20) {
  const query: Record<string, string> = { pageSize: String(pageSize), box: 'received' }
  if (pageToken) query.pageToken = pageToken
  return unwrap<CursorPage<ShareListItem>>(authedSharesApi.index.$get({ query }))
}

export function getShare(token: string) {
  return unwrap<ShareView>(publicSharesApi[':token'].$get({ param: { token } }))
}

export function revokeShare(token: string) {
  return unwrap<ShareView>(authedSharesApi[':token'].status.$put({ param: { token }, json: { status: 'revoked' } }))
}

export function setSharePrivacy(token: string, isPrivate: boolean) {
  return unwrap<{ private: boolean }>(
    authedSharesApi[':token'].privacy.$put({ param: { token }, json: { private: isPrivate } }),
  )
}

export interface CreateShareResult {
  token: string
  kind: ShareView['kind']
  urls: { landing?: string; direct?: string }
  expiresAt: string | null
  downloadLimit: number | null
  private: boolean
}

export function createShare(data: CreateShareRequest) {
  return unwrap<CreateShareResult>(authedSharesApi.index.$post({ json: data }))
}

export function verifySharePassword(token: string, password: string) {
  return unwrap<{ ok: boolean }>(publicSharesApi[':token'].sessions.$post({ param: { token }, json: { password } }))
}

export type ShareChildItem = ShareObjectItem
export type ShareChildrenResponse = ShareObjectsResponse

export function listShareObjects(token: string, parent = '', pageToken?: string, pageSize = 50) {
  return unwrap<ShareChildrenResponse>(
    publicSharesApi[':token'].objects.$get({
      param: { token },
      query: { parent, pageSize: String(pageSize), ...(pageToken ? { pageToken } : {}) },
    }),
  )
}

export function getShareReadme(token: string) {
  return unwrap<ShareReadmeResponse>(publicSharesApi[':token'].readme.$get({ param: { token } }))
}

export function buildShareObjectUrl(token: string, ref: string): string {
  return `/api/shares/${token}/objects/${ref}`
}

export interface SaveShareInput {
  targetParent: string
}

export interface SaveShareResult {
  saved: Array<{ id: string; name: string }>
  skipped: Array<{ name: string; reason: string }>
}

export function saveShareToDrive(token: string, data: SaveShareInput) {
  return unwrap<SaveShareResult>(authedSharesApi[':token'].objects.$post({ param: { token }, json: data }))
}

// Image Host API Keys (via better-auth apiKey plugin)

export interface PersonalApiKey {
  id: string
  configId: string
  name: string | null
  start: string | null
  prefix: string | null
  createdAt: string
  lastRequest: string | null
  permissions: Record<string, string[]> | null
  metadata: ApiKeyMetadata | null
  referenceId: string
  enabled: boolean
}

export interface CreatePersonalApiKeyResult extends PersonalApiKey {
  key: string
}

async function apiKeyFetch<T>(path: string, options: RequestInit): Promise<T> {
  const res = await fetch(`/api/auth${path}`, { credentials: 'include', ...options })
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}))
    throw new ApiError(res.status, toErrorBody(res.status, parsed))
  }
  return res.json() as Promise<T>
}

export function listApiKeys() {
  return apiKeyFetch<{ apiKeys: PersonalApiKey[] }>('/api-key/list', {
    method: 'GET',
  }).then((res) => res.apiKeys)
}

// WebDAV App Passwords (via better-auth apiKey plugin)

export type WebDavAppPassword = PersonalApiKey

export interface CreateWebDavAppPasswordResult extends WebDavAppPassword {
  key: string
}

export function createWebDavAppPassword(name: string) {
  return apiKeyFetch<CreateWebDavAppPasswordResult>('/api-key/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configId: 'webdav',
      name,
    }),
  })
}

export function revokeWebDavAppPassword(keyId: string) {
  return apiKeyFetch<{ success: boolean }>('/api-key/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configId: 'webdav', keyId }),
  })
}

export function getInstanceInfo() {
  return unwrap<InstanceInfo>(system.instance.$get())
}

export function getChangelog(opts?: { refresh?: boolean }) {
  return unwrap<ChangelogInfo>(system.changelog.$get({ query: opts?.refresh ? { refresh: 'true' } : {} }))
}

type SessionData = { session: unknown; user: unknown } | null

const SESSION_CACHE_TTL_MS = 5000 // 5 seconds

let sessionCache: { value: SessionData; at: number } | null = null
let sessionInflight: Promise<SessionData> | null = null

export function clearSessionCache() {
  sessionCache = null
  sessionInflight = null
}

async function fetchSession(): Promise<SessionData> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), SESSION_REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch('/api/auth/get-session', { credentials: 'include', signal: controller.signal })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(res.status, toErrorBody(res.status, body))
    }
    return res.json()
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Session request timed out')
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

// Auth API — Better Auth passthrough, not typed via Hono RPC.
// Concurrent callers share one in-flight request no matter how long it takes;
// a resolved value is served for SESSION_CACHE_TTL_MS; failures are not cached.
export function getSession(): Promise<SessionData> {
  if (sessionCache && Date.now() - sessionCache.at < SESSION_CACHE_TTL_MS) {
    return Promise.resolve(sessionCache.value)
  }
  if (sessionInflight) return sessionInflight

  const request = fetchSession()
    .then((value) => {
      sessionCache = { value, at: Date.now() }
      return value
    })
    .finally(() => {
      if (sessionInflight === request) sessionInflight = null
    })
  sessionInflight = request
  return request
}

export interface UploadProgress {
  loaded: number
  total: number
}

export interface UploadToS3Options {
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
  contentDisposition?: string
}

// S3 direct upload (external presigned URL, not our API)
export function uploadToS3(url: string, file: File, options: UploadToS3Options = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => {
      xhr.abort()
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }

    if (options.signal?.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'))
      return
    }

    options.signal?.addEventListener('abort', abort, { once: true })
    xhr.upload.onprogress = (event) => {
      options.onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : file.size,
      })
    }
    xhr.onload = () => {
      options.signal?.removeEventListener('abort', abort)
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.({ loaded: file.size, total: file.size })
        resolve()
        return
      }
      reject(new Error('Upload failed'))
    }
    xhr.onerror = () => {
      options.signal?.removeEventListener('abort', abort)
      reject(new Error('Upload failed'))
    }
    xhr.onabort = () => {
      options.signal?.removeEventListener('abort', abort)
    }
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    if (options.contentDisposition) {
      xhr.setRequestHeader('Content-Disposition', options.contentDisposition)
    }
    xhr.send(file)
  })
}

export interface UploadPartOptions {
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
  contentType?: string
}

/**
 * PUTs a single multipart part (external presigned URL) and resolves with its
 * ETag, which the multipart-complete call needs. The S3 bucket's CORS config
 * must expose the ETag response header for this to be readable from the browser.
 */
export function uploadPartToS3(url: string, blob: Blob, options: UploadPartOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => {
      xhr.abort()
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }

    if (options.signal?.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'))
      return
    }

    options.signal?.addEventListener('abort', abort, { once: true })
    xhr.upload.onprogress = (event) => {
      options.onProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : blob.size })
    }
    xhr.onload = () => {
      options.signal?.removeEventListener('abort', abort)
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag')
        if (!etag) {
          reject(new Error('Missing ETag — the storage bucket must expose the ETag header via CORS'))
          return
        }
        options.onProgress?.({ loaded: blob.size, total: blob.size })
        resolve(etag.replace(/"/g, ''))
        return
      }
      reject(new Error('Upload failed'))
    }
    xhr.onerror = () => {
      options.signal?.removeEventListener('abort', abort)
      reject(new Error('Upload failed'))
    }
    xhr.onabort = () => {
      options.signal?.removeEventListener('abort', abort)
    }
    xhr.open('PUT', url)
    if (options.contentType) xhr.setRequestHeader('Content-Type', options.contentType)
    xhr.send(blob)
  })
}

// Branding API

export type { BrandingConfig, BrandingField, BrandingThemeMode, BrandingThemePresetId, BrandingThemeValues }

// PUT uses multipart/form-data (logo/favicon are File objects).
// Hono RPC does not express multipart cleanly, so this uses raw fetch with FormData.
export async function saveBranding(data: {
  logo?: File | null
  favicon?: File | null
  wordmark_text?: string
  hide_powered_by?: boolean
  theme_mode?: BrandingThemeMode
  theme_preset?: BrandingThemePresetId
  theme_custom?: BrandingThemeValues
}): Promise<BrandingConfig> {
  const form = new FormData()
  if (data.logo) form.set('logo', data.logo)
  if (data.favicon) form.set('favicon', data.favicon)
  // Empty string is submitted as an explicit clear; server treats it as setting wordmark to "".
  // Use resetBrandingField('wordmark_text') to fully remove the key.
  if (data.wordmark_text !== undefined) form.set('wordmark_text', data.wordmark_text)
  if (data.hide_powered_by !== undefined) form.set('hide_powered_by', data.hide_powered_by ? 'true' : 'false')
  if (data.theme_mode !== undefined) form.set('theme_mode', data.theme_mode)
  if (data.theme_preset !== undefined) form.set('theme_preset', data.theme_preset)
  if (data.theme_custom) {
    form.set('theme_primary_color', data.theme_custom.primary_color)
    form.set('theme_primary_foreground', data.theme_custom.primary_foreground)
    form.set('theme_canvas_color', data.theme_custom.canvas_color)
    form.set('theme_sidebar_accent_color', data.theme_custom.sidebar_accent_color)
    form.set('theme_ring_color', data.theme_custom.ring_color)
  }

  const res = await fetch('/api/site/settings/branding', {
    method: 'PUT',
    body: form,
    credentials: 'include',
  })
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}))
    throw new ApiError(res.status, toErrorBody(res.status, parsed))
  }
  return res.json() as Promise<BrandingConfig>
}

export async function resetBrandingField(field: BrandingField): Promise<void> {
  const res = await brandingAdminApi[':field'].$delete({ param: { field } })
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({}))
    throw new ApiError(res.status, toErrorBody(res.status, parsed))
  }
}
