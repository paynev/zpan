// The objects resource usecase. Owns every business decision behind the
// /api/objects routes — upload sessions, listing, detail/download, rename/move,
// trash/restore, permanent purge, and copy — so the http handlers only parse
// the request, call these functions, and serialize the result.
//
// All port access lives here: the handler never reaches into `deps.<port>`.
// Expected failures the handler maps to a status code are returned as
// discriminated-union outcomes; the multipart upload-session validation keeps
// throwing ObjectUploadSessionError because the handler already maps its code to
// 404 / 409 / 502.

import { DirType } from '@shared/constants'
import type {
  ActorProfile,
  CompleteObjectUploadInput,
  ConflictStrategy,
  CreateMatterInput,
  PatchMatterInput,
  PresignObjectUploadPartsInput,
} from '@shared/schemas'
import type { ObjectUploadInstructions } from '@shared/types'
import { buildObjectKey, fileExt } from '../lib/path-template'
import { resolveActorProfiles } from './audit-actors'
import type { Deps } from './deps'
import {
  type ActorIdentity,
  type AppError,
  actorIdentityKey,
  badRequest,
  type Matter,
  type MatterListFilters,
  type MatterRepo,
  noStorage,
  notFound,
  ObjectUploadSessionError,
  type S3Gateway,
  type ShareRepo,
  type StorageRecord,
  type StorageRepo,
  type StorageUsageRepo,
  storageNotFound,
} from './ports'
import { withStorageUsageReservation } from './storage-usage'

export { ObjectUploadSessionError } from './ports'

// The copy request shape (mirrors copyMatterSchema; no shared type is exported).
export interface CopyObjectInput {
  copyFrom: string
  parent: string
  onConflict?: ConflictStrategy
}

// The caller identity, derived from the request principal.
export type ObjectActor = { kind: 'user'; userId: string; identity?: ActorIdentity }

function creatorIdentity(actor: ObjectActor): ActorIdentity {
  if (actor.identity) return actor.identity
  return { type: 'user', ref: actor.userId, issuer: null }
}

// ─── List ────────────────────────────────────────────────────────────────────

export type ListObjectsOutcome =
  | { ok: true; result: Awaited<ReturnType<Deps['matter']['list']>> }
  | { ok: false; error: AppError }

export async function listObjects(
  deps: Pick<Deps, 'matter'>,
  params: { filters: MatterListFilters },
): Promise<ListObjectsOutcome> {
  const result = await deps.matter.list(params.filters)
  return { ok: true, result }
}

// ─── Create (folder, or file draft + size-decided upload) ─────────────────────

// The server picks the S3 mechanism by size: small objects use single PutObject,
// larger objects use S3 multipart with explicit part descriptors. Multipart
// defaults to automation-friendly 64 MiB chunks but grows when needed to respect
// S3's 10,000-part ceiling and 5 TiB single-object maximum.
const SINGLE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024 // 64 MiB
const DEFAULT_MULTIPART_PART_SIZE_BYTES = 64 * 1024 * 1024 // 64 MiB
const MAX_UPLOAD_PARTS = 10_000
const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024 * 1024 // 5 TiB
export const UPLOAD_PRESIGNED_URL_TTL_SECONDS = 15 * 60

export type CreateObjectOutcome =
  | { ok: true; matter: Matter }
  | { ok: true; matter: Matter; upload: ObjectUploadInstructions }
  | { ok: false; error: AppError }

export async function createObject(
  deps: Pick<Deps, 'matter' | 'storages' | 's3' | 'objectUploadSessions'>,
  params: { actor: ObjectActor; input: CreateMatterInput },
): Promise<CreateObjectOutcome> {
  const { actor, input } = params
  const createdBy = creatorIdentity(actor)
  const { name, type, dirtype, onConflict } = input
  const parent = input.parent
  const isFolder = dirtype !== DirType.FILE
  const size = input.size ?? 0

  // Reject oversize before creating anything, so no orphan draft is left behind.
  if (!isFolder && size > MAX_OBJECT_BYTES) {
    return { ok: false, error: badRequest('File exceeds the 5 TiB maximum', 'FILE_TOO_LARGE') }
  }

  const _conflictPlan = isFolder
    ? null
    : await deps.matter.planConflictResolution(parent, name, onConflict ?? 'fail', { isFolder: false })

  let storage: StorageRecord
  try {
    storage = await deps.storages.select(input.storageId)
  } catch (error) {
    if (error instanceof Error && error.message === 'No available storage') {
      return {
        ok: false,
        error: input.storageId ? noStorage('Storage is not active or has no available capacity') : noStorage(),
      }
    }
    throw error
  }

  const objectKey = isFolder ? '' : buildObjectKey({ uid: actor.userId, rawExt: fileExt(name) })

  const matter = await deps.matter.create({
    name,
    type: isFolder ? 'folder' : (type ?? ''),
    size: isFolder ? 0 : size,
    dirtype,
    parent,
    object: objectKey,
    storageId: storage.id,
    status: isFolder ? 'active' : 'draft',
    createdByActorType: createdBy.type,
    createdByActorRef: createdBy.ref,
    createdByActorIssuer: createdBy.issuer,
    onConflict,
  })

  if (isFolder) return { ok: true, matter }

  const upload = await prepareUpload(deps, {
    objectId: matter.id,
    storage,
    storageKey: objectKey,
    contentType: type,
    size,
    onConflict: onConflict ?? 'fail',
    actorId: actor.userId,
  })
  return { ok: true, matter, upload }
}

export function matterCreatorIdentity(matter: Matter): ActorIdentity | null {
  if (!matter.createdByActorType || !matter.createdByActorRef) return null
  return {
    type: matter.createdByActorType as ActorIdentity['type'],
    ref: matter.createdByActorRef,
    issuer: matter.createdByActorIssuer ?? null,
  }
}

export type GetObjectCreatorOutcome = { ok: true; creator: ActorProfile } | { ok: false; error: AppError }

export async function getObjectCreator(
  deps: Pick<Deps, 'matter' | 'auditActorDirectory' | 'agentInfo'>,
  params: { objectId: string },
): Promise<GetObjectCreatorOutcome> {
  const matter = await deps.matter.get(params.objectId)
  if (!matter || matter.trashedAt != null) return { ok: false, error: notFound() }
  const identity = matterCreatorIdentity(matter)
  if (!identity) return { ok: false, error: notFound() }
  const profiles = await resolveActorProfiles(deps, [identity])
  const profile = profiles.get(actorIdentityKey(identity))
  if (!profile) return { ok: false, error: notFound() }
  return {
    ok: true,
    creator: {
      ...identity,
      name: profile.name,
      image: profile.image,
      ...(profile.profileUrl !== undefined ? { profileUrl: profile.profileUrl } : {}),
    },
  }
}

// Decides the S3 mechanism, presigns every URL up front, and records the upload
// session. The chosen onConflict is stored on the session so completion can apply
// a deferred 'replace' (createMatter keeps the incumbent until bytes land).
async function prepareUpload(
  deps: Pick<Deps, 's3' | 'objectUploadSessions'>,
  params: {
    objectId: string
    storage: StorageRecord
    storageKey: string
    contentType?: string
    size: number
    onConflict: ConflictStrategy
    actorId: string
  },
): Promise<ObjectUploadInstructions> {
  const { storage, storageKey, contentType, size } = params
  let uploadId: string | null = null
  let partSize: number
  let partCount: number
  let parts: ObjectUploadInstructions['parts']
  const headers = signedUploadHeaders(contentType)
  const presignedExpiresAt = new Date(Date.now() + UPLOAD_PRESIGNED_URL_TTL_SECONDS * 1000).toISOString()

  if (size <= SINGLE_UPLOAD_MAX_BYTES) {
    // Single PutObject — one presigned PUT, no S3 multipart overhead. When the
    // client supplied a content type it is signed and must be sent verbatim.
    partSize = size
    partCount = 1
    parts = [
      {
        partNumber: 1,
        url: await deps.s3.presignUpload(storage, storageKey, contentType, UPLOAD_PRESIGNED_URL_TTL_SECONDS),
        expiresAt: presignedExpiresAt,
        headers,
        offset: 0,
        length: size,
      },
    ]
  } else {
    partSize = Math.max(DEFAULT_MULTIPART_PART_SIZE_BYTES, Math.ceil(size / MAX_UPLOAD_PARTS))
    partCount = Math.ceil(size / partSize)
    try {
      uploadId = await deps.s3.createMultipartUpload(storage, storageKey, contentType)
    } catch (error) {
      throw new ObjectUploadSessionError(
        'storage_failure',
        `Storage multipart upload failed: ${(error as Error).message}`,
      )
    }
    const mpId = uploadId
    parts = await Promise.all(
      Array.from({ length: partCount }, async (_, i) => ({
        partNumber: i + 1,
        url: await deps.s3.presignUploadPart(storage, storageKey, mpId, i + 1, UPLOAD_PRESIGNED_URL_TTL_SECONDS),
        expiresAt: presignedExpiresAt,
        headers: {},
        offset: i * partSize,
        length: Math.min(partSize, size - i * partSize),
      })),
    )
  }

  const record = await deps.objectUploadSessions.create({
    objectId: params.objectId,
    storageId: storage.id,
    storageKey,
    uploadId,
    partSize,
    onConflict: params.onConflict,
    actorId: params.actorId,
  })
  return {
    sessionId: record.id,
    uploadId,
    mode: uploadId == null ? 'single' : 'multipart',
    partSize,
    partCount,
    expiresAt: record.expiresAt.toISOString(),
    presignedExpiresAt,
    requiredHeaders: uploadId == null ? headers : {},
    urls: parts.map((part) => part.url),
    parts,
    workflow: uploadWorkflow(params.objectId, record.id),
  }
}

function uploadWorkflow(objectId: string, sessionId: string): ObjectUploadInstructions['workflow'] {
  const sessionPath = `/api/objects/${objectId}/uploads/${sessionId}`
  return {
    version: '1',
    upload: {
      method: 'PUT',
      urlField: 'parts[].url',
      headersField: 'parts[].headers',
      fileOffsetField: 'parts[].offset',
      contentLengthField: 'parts[].length',
      etagHeader: 'ETag',
    },
    complete: {
      operationId: 'completeObjectUpload',
      method: 'POST',
      path: `${sessionPath}/completions`,
      partsBodyField: 'parts',
    },
    rePresign: {
      operationId: 'presignObjectUploadParts',
      method: 'POST',
      path: `${sessionPath}/parts`,
      partNumbersBodyField: 'partNumbers',
    },
    abort: {
      operationId: 'abortObjectUpload',
      method: 'DELETE',
      path: sessionPath,
    },
  }
}

function signedUploadHeaders(contentType?: string): Record<string, string> {
  return contentType ? { 'content-type': contentType } : {}
}

function uploadPartCount(size: number, partSize: number): number {
  if (partSize <= 0) return 1
  return Math.max(1, Math.ceil(size / partSize))
}

function normalizeETag(etag: string): string {
  return etag.trim().replace(/^"+|"+$/g, '')
}

function validateCompletionParts(
  parts: CompleteObjectUploadInput['parts'],
  requiredPartCount: number,
): Array<{ partNumber: number; etag: string }> {
  const normalized = parts.map((part) => ({ partNumber: part.partNumber, etag: normalizeETag(part.etag) }))
  const seen = new Set<number>()
  for (const part of normalized) {
    if (part.partNumber < 1 || part.partNumber > requiredPartCount || seen.has(part.partNumber) || !part.etag) {
      throw new ObjectUploadSessionError('invalid_state', 'Upload completion parts do not match the session')
    }
    seen.add(part.partNumber)
  }
  if (seen.size !== requiredPartCount) {
    throw new ObjectUploadSessionError('invalid_state', 'Upload completion parts do not match the session')
  }
  return normalized.sort((a, b) => a.partNumber - b.partNumber)
}

// ─── Upload finalize / abort / re-presign ─────────────────────────────────────
// These throw ObjectUploadSessionError (not_found / invalid_state /
// storage_failure); the handler maps the code to 404 / 409 / 502.

async function loadObjectForUploadSession(
  deps: Pick<Deps, 'matter' | 'storages'>,
  objectId: string,
): Promise<{ matter: Matter; storage: StorageRecord }> {
  const matter = await deps.matter.get(objectId)
  if (!matter) throw new ObjectUploadSessionError('not_found')
  const storage = await deps.storages.get(matter.storageId)
  if (!storage) throw new ObjectUploadSessionError('not_found')
  return { matter, storage }
}

// Re-presign expired part URLs mid-upload. The happy path uses the URLs returned
// by createObject; this is the fallback for interrupted or long-running clients.
export async function presignUploadSessionParts(
  deps: Pick<Deps, 'matter' | 'storages' | 's3' | 'objectUploadSessions'>,
  params: {
    objectId: string
    sessionId: string
    partNumbers: PresignObjectUploadPartsInput['partNumbers']
  },
): Promise<{
  uploadId: string | null
  mode: 'single' | 'multipart'
  partSize: number
  partCount: number
  presignedExpiresAt: string
  requiredHeaders: Record<string, string>
  parts: ObjectUploadInstructions['parts']
}> {
  const { matter, storage } = await loadObjectForUploadSession(deps, params.objectId)
  const record = await deps.objectUploadSessions.get(params.objectId, params.sessionId)
  if (!record) throw new ObjectUploadSessionError('not_found')
  if (record.status !== 'active' || record.expiresAt.getTime() <= Date.now()) {
    throw new ObjectUploadSessionError('invalid_state')
  }
  const partCount = uploadPartCount(matter.size ?? 0, record.partSize)
  if (new Set(params.partNumbers).size !== params.partNumbers.length) {
    throw new ObjectUploadSessionError('invalid_state', 'Duplicate part numbers are not allowed')
  }
  for (const partNumber of params.partNumbers) {
    if (partNumber < 1 || partNumber > partCount) {
      throw new ObjectUploadSessionError('invalid_state', 'Part number is outside this upload session')
    }
  }
  const presignedExpiresAt = new Date(Date.now() + UPLOAD_PRESIGNED_URL_TTL_SECONDS * 1000).toISOString()
  if (record.uploadId == null) {
    const headers = signedUploadHeaders(matter.type || undefined)
    const parts = await Promise.all(
      params.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await deps.s3.presignUpload(
          storage,
          record.storageKey,
          matter.type || undefined,
          UPLOAD_PRESIGNED_URL_TTL_SECONDS,
        ),
        expiresAt: presignedExpiresAt,
        headers,
        offset: 0,
        length: matter.size ?? 0,
      })),
    )
    return {
      uploadId: null,
      mode: 'single',
      partSize: record.partSize,
      partCount,
      presignedExpiresAt,
      requiredHeaders: headers,
      parts,
    }
  }
  const uploadId = record.uploadId
  const parts = await Promise.all(
    params.partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await deps.s3.presignUploadPart(
        storage,
        record.storageKey,
        uploadId,
        partNumber,
        UPLOAD_PRESIGNED_URL_TTL_SECONDS,
      ),
      expiresAt: presignedExpiresAt,
      headers: {},
      offset: (partNumber - 1) * record.partSize,
      length: Math.min(record.partSize, (matter.size ?? 0) - (partNumber - 1) * record.partSize),
    })),
  )
  return {
    uploadId,
    mode: 'multipart',
    partSize: record.partSize,
    partCount,
    presignedExpiresAt,
    requiredHeaders: {},
    parts,
  }
}

export type CompleteUploadOutcome =
  | { ok: true; matter: Matter }
  | { ok: false; reason: 'not_found' }
  | { ok: false; error: AppError }

// Finalizes a draft upload (draft → live). Multipart uploads are completed first,
// then every upload is HEADed so the persisted type matches the object's final
// metadata. Single PutObject uploads additionally verify the reported ETag.
export async function completeUpload(
  deps: Pick<Deps, 'matter' | 'storages' | 's3' | 'objectUploadSessions' | 'storageUsage' | 'share'>,
  params: {
    objectId: string
    sessionId: string
    parts: CompleteObjectUploadInput['parts']
    actorId: string
  },
): Promise<CompleteUploadOutcome> {
  const { matter: sessionMatter, storage } = await loadObjectForUploadSession(deps, params.objectId)
  const record = await deps.objectUploadSessions.get(params.objectId, params.sessionId)
  if (!record) throw new ObjectUploadSessionError('not_found')
  const retryingCompletedMultipartActivation =
    record.status === 'completed' && record.uploadId != null && sessionMatter.status === 'draft'
  if (record.status === 'completed') {
    if (sessionMatter.status === 'active') return { ok: true, matter: sessionMatter }
    if (!retryingCompletedMultipartActivation) throw new ObjectUploadSessionError('invalid_state')
  }
  if (
    (record.status !== 'active' && !retryingCompletedMultipartActivation) ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw new ObjectUploadSessionError('invalid_state')
  }

  const completedParts = validateCompletionParts(
    params.parts,
    uploadPartCount(sessionMatter.size ?? 0, record.partSize),
  )

  if (record.uploadId != null && !retryingCompletedMultipartActivation) {
    try {
      await deps.s3.completeMultipartUpload(storage, record.storageKey, record.uploadId, completedParts)
    } catch (error) {
      throw new ObjectUploadSessionError(
        'storage_failure',
        `Storage multipart upload complete failed: ${(error as Error).message}`,
      )
    }
    await deps.objectUploadSessions.setStatus(record.id, 'completed')
  }

  let head: { size: number; contentType?: string; etag: string }
  try {
    head = await deps.s3.headObject(storage, record.storageKey)
  } catch (error) {
    throw new ObjectUploadSessionError(
      'invalid_state',
      `Uploaded object not found: ${(error as Error).message}`,
      'object_not_found',
    )
  }
  if (record.uploadId == null) {
    const reported = completedParts[0]?.etag
    if (!reported || reported !== head.etag) {
      throw new ObjectUploadSessionError('invalid_state', 'Uploaded object ETag does not match', 'etag_mismatch')
    }
  }
  // Draft → live: apply the stored conflict strategy, activate.
  const { matter } = await confirmUpload(deps, params.objectId, {
    onConflict: record.onConflict,
    contentType: head.contentType ?? null,
    purgeReplaced: (incumbent) => purgeRecursively(deps, [incumbent]).then(() => undefined),
  })
  if (!matter) {
    return { ok: false, reason: 'not_found' }
  }
  if (record.uploadId == null) {
    await deps.objectUploadSessions.setStatus(record.id, 'completed')
  }
  return { ok: true, matter }
}

// Aborts an in-progress upload and discards the draft. Retries finish draft
// cleanup if a previous abort marked the session first; rejects active completions.
export async function abortUpload(
  deps: Pick<Deps, 'matter' | 'storages' | 's3' | 'objectUploadSessions'>,
  params: { objectId: string; sessionId: string; actorId: string; strictStorageCleanup?: boolean },
): Promise<void> {
  const record = await deps.objectUploadSessions.get(params.objectId, params.sessionId)
  if (!record) throw new ObjectUploadSessionError('not_found')
  if (record.status === 'aborted') {
    const sessionMatter = await deps.matter.get(params.objectId)
    if (sessionMatter?.status === 'draft') {
      await deps.matter.cancelDraft(params.objectId)
    }
    return
  }

  const { matter: sessionMatter, storage } = await loadObjectForUploadSession(deps, params.objectId)
  if (record.status === 'completed') {
    if (sessionMatter.status !== 'draft' || record.uploadId == null) {
      throw new ObjectUploadSessionError('invalid_state', 'Upload already completed')
    }
    try {
      await deps.s3.deleteObject(storage, record.storageKey)
    } catch (error) {
      throw new ObjectUploadSessionError('storage_failure', `Storage cleanup failed: ${(error as Error).message}`)
    }
    await deps.objectUploadSessions.setStatus(record.id, 'aborted')
    await deps.matter.cancelDraft(params.objectId)
    return
  }

  if (record.uploadId != null) {
    try {
      await deps.s3.abortMultipartUpload(storage, record.storageKey, record.uploadId)
    } catch (error) {
      throw new ObjectUploadSessionError(
        'storage_failure',
        `Storage multipart upload abort failed: ${(error as Error).message}`,
      )
    }
  } else {
    // Single PutObject: best-effort cleanup; the browser may abort before any
    // bytes reach S3.
    try {
      await deps.s3.deleteObject(storage, record.storageKey)
    } catch (error) {
      if (params.strictStorageCleanup) {
        throw new ObjectUploadSessionError('storage_failure', `Storage cleanup failed: ${(error as Error).message}`)
      }
    }
  }
  await deps.objectUploadSessions.setStatus(record.id, 'aborted')
  await deps.matter.cancelDraft(params.objectId)
}

// ─── Detail / download ────────────────────────────────────────────────────────

export type GetObjectOutcome =
  | { ok: true; matter: Matter }
  | { ok: true; matter: Matter; downloadUrl: string }
  | { ok: false; error: AppError }

// Loads an object; for files it presigns the download URL.
export async function getObject(
  deps: Pick<Deps, 'matter' | 'storages' | 's3'>,
  params: { objectId: string },
): Promise<GetObjectOutcome> {
  const matter = await deps.matter.get(params.objectId)
  // Live objects only — a trashed object is fetched via GET /trash/objects/{id}.
  if (!matter || matter.trashedAt != null) return { ok: false, error: notFound() }
  if (matter.dirtype !== DirType.FILE || !matter.object) return { ok: true, matter }

  const storage = await deps.storages.get(matter.storageId)
  if (!storage) return { ok: false, error: storageNotFound() }

  const downloadUrl = await deps.s3.presignDownload(storage, matter.object, matter.name)
  return { ok: true, matter, downloadUrl }
}

// ─── Trash listing / detail ─────────────────────────────────────────────────

// Lists trashed objects, ROOTS ONLY (a trashed folder shows one entry, not its
// cascade-marked subtree). Paginated over the root set.
export async function listTrashedObjects(
  deps: Pick<Deps, 'matter'>,
  params: {
    pageSize: number
    after?: { trashedAt: number; createdAt: Date; id: string }
  },
): Promise<{
  ok: true
  result: {
    items: Matter[]
    nextBoundary: { trashedAt: number; createdAt: Date; id: string } | null
  }
}> {
  const result = await deps.matter.listTrashedRootPage({
    pageSize: params.pageSize,
    after: params.after,
  })
  return {
    ok: true,
    result,
  }
}

// Loads a single trashed object (GET /trash/objects/{id}); a live object is 404
// here (use GET /objects/{id}).
export async function getTrashObject(
  deps: Pick<Deps, 'matter'>,
  params: { objectId: string },
): Promise<{ ok: true; matter: Matter } | { ok: false; error: AppError }> {
  const matter = await deps.matter.get(params.objectId)
  if (!matter || matter.trashedAt == null) return { ok: false, error: notFound() }
  return { ok: true, matter }
}

// ─── Update / trash / restore ──────────────────────────────────────────────────

export type UpdateObjectOutcome = { ok: true; matter: Matter } | { ok: false; error: AppError }

export async function updateObject(
  deps: Pick<Deps, 'matter'>,
  params: { objectId: string; input: PatchMatterInput },
): Promise<UpdateObjectOutcome> {
  const { name, parent, onConflict } = params.input
  const existing = await deps.matter.get(params.objectId)
  if (!existing) return { ok: false, error: notFound() }
  const matter = await deps.matter.update(params.objectId, { name, parent, onConflict })
  return matter ? { ok: true, matter } : { ok: false, error: notFound() }
}

export type TrashObjectOutcome = { ok: true; matter: Matter } | { ok: false; error: AppError }

export async function trashObject(
  deps: Pick<Deps, 'matter'>,
  params: { objectId: string },
): Promise<TrashObjectOutcome> {
  const existing = await deps.matter.get(params.objectId)
  if (!existing) return { ok: false, error: notFound() }
  const matter = await deps.matter.trash(params.objectId)
  return matter ? { ok: true, matter } : { ok: false, error: notFound() }
}

export type RestoreObjectOutcome = { ok: true; matter: Matter } | { ok: false; error: AppError }

export async function restoreObject(
  deps: Pick<Deps, 'matter'>,
  params: { objectId: string; onConflict?: ConflictStrategy },
): Promise<RestoreObjectOutcome> {
  const matter = await deps.matter.restore(params.objectId, params.onConflict ?? 'fail')
  return matter ? { ok: true, matter } : { ok: false, error: notFound() }
}

// ─── Permanent delete (purge) ─────────────────────────────────────────────────

export type DeleteObjectOutcome =
  | { ok: true; id: string; purged: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_trashed' }

export async function deleteObject(
  deps: Pick<Deps, 'matter' | 'storages' | 's3' | 'storageUsage' | 'share'>,
  params: { objectId: string },
): Promise<DeleteObjectOutcome> {
  const ms = await deps.matter.collectForPurge(params.objectId)
  if (!ms) return { ok: false, reason: 'not_found' }
  // Only a trashed object can be permanently purged.
  if (ms[0].trashedAt == null) return { ok: false, reason: 'not_trashed' }
  const purged = await purgeRecursively(deps, ms)
  return { ok: true, id: ms[0].id, purged }
}

// ─── Copy ────────────────────────────────────────────────────────────────────

export type CopyObjectOutcome = { ok: true; matter: Matter } | { ok: false; error: AppError }

export async function copyObject(
  deps: Pick<Deps, 'matter' | 'storages' | 's3' | 'storageUsage'>,
  params: { userId: string; actor?: ObjectActor; input: CopyObjectInput },
): Promise<CopyObjectOutcome> {
  const { userId, input } = params
  const identity = params.actor ? creatorIdentity(params.actor) : { type: 'user' as const, ref: userId, issuer: null }
  const { copyFrom, parent, onConflict } = input
  const source = await deps.matter.get(copyFrom)
  if (!source || source.trashedAt != null) return { ok: false, error: notFound() }

  const _sourceSize = source.size ?? 0
  const storage = source.object ? await deps.storages.get(source.storageId) : null
  if (source.object && !storage) return { ok: false, error: storageNotFound() }

  const copy = await withStorageUsageReservation(deps, {}, async (ctx) => {
    let newObject = ''
    if (source.object) {
      // storage is non-null here: a missing storage for an object-backed source
      // returns storage_not_found above.
      const objectStorage = storage as StorageRecord
      newObject = buildObjectKey({ uid: userId, rawExt: fileExt(source.name) })
      await deps.s3.copyObject(objectStorage, source.object, objectStorage, newObject)
      ctx.onRollback(() => deps.s3.deleteObject(objectStorage, newObject))
    }
    return deps.matter.copy(source, parent, newObject, {
      onConflict,
      createdByActorType: identity.type,
      createdByActorRef: identity.ref,
      createdByActorIssuer: identity.issuer,
    })
  })
  return { ok: true, matter: copy }
}

// ── upload confirmation (draft → active) ─────────────────────────────────────

// Draft→active confirmation. Composes the matter repo (conflict plan + draft
// activation), reaching the DB only through deps.
export type ConfirmUploadDeps = {
  matter: MatterRepo
  storageUsage: StorageUsageRepo
}

export interface ConfirmUploadOptions {
  onConflict?: ConflictStrategy
  /** Undefined preserves the draft value; null records that storage returned no type. */
  contentType?: string | null
  /**
   * Overwrites the file being replaced: hard-purge it (delete row, S3 object,
   * shares). With it, a 'replace' frees the incumbent's quota so the upload is
   * charged as a net-size change — matching normal overwrite semantics. Without
   * it, replace falls back to trashing the incumbent.
   */
  purgeReplaced?: (incumbent: Matter) => Promise<void>
}

export async function confirmUpload(
  deps: ConfirmUploadDeps,
  id: string,
  opts: ConfirmUploadOptions = {},
): Promise<{ matter: Matter | null }> {
  const existing = await deps.matter.get(id)
  if (!existing) return { matter: null }
  if (existing.status !== 'draft') return { matter: null }

  // Plan the overwrite now (side-effect-free). createMatter deferred it for
  // draft 'replace', so the incumbent is still active. The DB's partial unique
  // index fires on the status update as a final safety net against concurrent confirms.
  const plan = await deps.matter.planConflictResolution(existing.parent, existing.name, opts.onConflict ?? 'fail', {
    excludeId: existing.id,
    isFolder: false,
  })

  // Quota reserved — now safe to execute the overwrite (if any).
  if (plan.toTrash && opts.purgeReplaced) {
    await opts.purgeReplaced(plan.toTrash)
  } else {
    await deps.matter.commitConflictPlan(plan)
  }

  const now = new Date()
  const type = opts.contentType === undefined ? existing.type : (opts.contentType ?? '')
  const activated = await deps.matter.activateDraft(id, plan.finalName, type, now)
  if (!activated) {
    throw new Error('CONFIRM_UPLOAD_RACE')
  }

  const confirmed = { ...existing, name: plan.finalName, type, status: 'active', updatedAt: now }
  return { matter: confirmed }
}

// ── recursive purge ──────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_TRASH_RETENTION_DAYS = 30

export type PurgeDeps = {
  s3: S3Gateway
  storages: StorageRepo
  storageUsage: StorageUsageRepo
  share: ShareRepo
  matter: MatterRepo
}

export async function purgeRecursively(deps: PurgeDeps, matters: Matter[]): Promise<number> {
  const keysByStorage = new Map<string, { storage: StorageRecord | null; keys: string[] }>()
  const affectedStorageIds = new Set<string>()

  for (const m of matters) {
    if (m.dirtype === DirType.FILE) affectedStorageIds.add(m.storageId)
    if (!m.object) continue
    let entry = keysByStorage.get(m.storageId)
    if (!entry) {
      const storage = await deps.storages.get(m.storageId)
      entry = { storage, keys: [] }
      keysByStorage.set(m.storageId, entry)
    }
    entry.keys.push(m.object)
  }

  for (const { storage, keys } of keysByStorage.values()) {
    if (storage && keys.length > 0) await deps.s3.deleteObjects(storage, keys)
  }

  for (const m of matters) {
    await deps.share.revokeByMatter(m.id)
  }

  await deps.matter.purge(matters.map((m) => m.id))
  if (affectedStorageIds.size > 0) await deps.storageUsage.reconcile(affectedStorageIds)
  return matters.length
}

/** Parses ZPAN_TRASH_RETENTION_DAYS; falls back to the default, 0 disables purge. */
export function resolveTrashRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRASH_RETENTION_DAYS
  const days = Number(raw)
  if (!Number.isFinite(days) || days < 0) return DEFAULT_TRASH_RETENTION_DAYS
  return Math.floor(days)
}

/**
 * Permanently purges trashed items older than `retentionDays`, reclaiming their
 * usage counters. Retention of 0 disables auto-purge. Runs subtree at a time via
 * the same purge path as emptying the trash manually.
 */
export async function purgeExpiredTrash(deps: PurgeDeps, retentionDays: number, now = Date.now()): Promise<number> {
  if (retentionDays <= 0) return 0
  const cutoff = now - retentionDays * DAY_MS
  const roots = await deps.matter.listTrashedRoots()

  let purged = 0
  for (const root of roots) {
    if ((root.trashedAt ?? 0) >= cutoff) continue
    const matters = await deps.matter.collectForPurge(root.id)
    if (!matters) continue
    purged += await purgeRecursively(deps, matters)
  }
  return purged
}

// ── save to drive ────────────────────────────────────────────────────────────

// Pure orchestration: copies a shared matter (file or folder) into the user's
// own space. Reaches the outside world only through deps; matter creation goes
// through the matter repo port.

export type SaveToDriveDeps = {
  s3: S3Gateway
  storages: StorageRepo
  storageUsage: StorageUsageRepo
  share: ShareRepo
  matter: MatterRepo
}

export interface SaveShareInput {
  matter: Matter
  currentUserId: string
  targetParent: string
  createdBy?: ActorIdentity
}

export interface SaveShareResult {
  saved: Matter[]
  skipped: Array<{ name: string; reason: string }>
}

function buildPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

async function saveFile(
  deps: SaveToDriveDeps,
  sourceMatter: Matter,
  sourceStorage: StorageRecord,
  targetStorage: StorageRecord,
  currentUserId: string,
  targetParent: string,
  createdBy: ActorIdentity = { type: 'user', ref: currentUserId, issuer: null },
): Promise<Matter> {
  const bytes = sourceMatter.size ?? 0
  const dstKey = buildObjectKey({ uid: currentUserId, rawExt: fileExt(sourceMatter.name) })

  return withStorageUsageReservation(deps, {}, async (ctx) => {
    if (sourceStorage.id === targetStorage.id) {
      await deps.s3.copyObject(sourceStorage, sourceMatter.object, targetStorage, dstKey)
    } else {
      await deps.s3.streamCopy(sourceStorage, sourceMatter.object, targetStorage, dstKey)
    }
    ctx.onRollback(() => deps.s3.deleteObject(targetStorage, dstKey))

    const newMatter = await deps.matter.create({
      name: sourceMatter.name,
      type: sourceMatter.type,
      size: bytes,
      dirtype: DirType.FILE,
      parent: targetParent,
      object: dstKey,
      storageId: targetStorage.id,
      status: 'active',
      onConflict: 'rename',
      createdByActorType: createdBy.type,
      createdByActorRef: createdBy.ref,
      createdByActorIssuer: createdBy.issuer,
    })

    return newMatter
  })
}

async function saveFolderRecursive(
  deps: SaveToDriveDeps,
  sourceFolderMatter: Matter,
  sourceStorage: StorageRecord,
  targetStorage: StorageRecord,
  currentUserId: string,
  targetParent: string,
  createdBy: ActorIdentity = { type: 'user', ref: currentUserId, issuer: null },
): Promise<SaveShareResult> {
  const saved: Matter[] = []
  const skipped: Array<{ name: string; reason: string }> = []

  const rootFolder = await deps.matter.create({
    name: sourceFolderMatter.name,
    type: 'folder',
    size: 0,
    dirtype: sourceFolderMatter.dirtype ?? undefined,
    parent: targetParent,
    object: '',
    storageId: targetStorage.id,
    status: 'active',
    onConflict: 'rename',
    createdByActorType: createdBy.type,
    createdByActorRef: createdBy.ref,
    createdByActorIssuer: createdBy.issuer,
  })
  saved.push(rootFolder)

  const sourceRootPath = buildPath(sourceFolderMatter.parent, sourceFolderMatter.name)
  const targetRootPath = buildPath(targetParent, rootFolder.name)

  const queue: Array<{ sourcePath: string; targetPath: string }> = [
    { sourcePath: sourceRootPath, targetPath: targetRootPath },
  ]

  while (queue.length > 0) {
    const { sourcePath, targetPath } = queue.shift()!
    const children = await deps.share.listDirectActiveChildren(sourcePath)

    for (const child of children) {
      if (child.dirtype === DirType.FILE) {
        try {
          const newFile = await saveFile(
            deps,
            child,
            sourceStorage,
            targetStorage,
            currentUserId,
            targetPath,
            createdBy,
          )
          saved.push(newFile)
        } catch (e) {
          skipped.push({ name: child.name, reason: (e as Error).message })
        }
      } else {
        const newFolder = await deps.matter.create({
          name: child.name,
          type: 'folder',
          size: 0,
          dirtype: child.dirtype ?? undefined,
          parent: targetPath,
          object: '',
          storageId: targetStorage.id,
          status: 'active',
          onConflict: 'rename',
          createdByActorType: createdBy.type,
          createdByActorRef: createdBy.ref,
          createdByActorIssuer: createdBy.issuer,
        })
        saved.push(newFolder)
        queue.push({
          sourcePath: buildPath(child.parent, child.name),
          targetPath: buildPath(targetPath, newFolder.name),
        })
      }
    }
  }

  return { saved, skipped }
}

// Copy a file or folder (recursively) into the user's own space. Files that fail
// are reported in `skipped` rather than failing the whole operation.
export async function saveShareToDrive(deps: SaveToDriveDeps, input: SaveShareInput): Promise<SaveShareResult> {
  const { matter: sourceMatter, currentUserId, targetParent, createdBy } = input

  const sourceStorage = await deps.storages.get(sourceMatter.storageId)
  if (!sourceStorage) throw new Error('Source storage not found')

  const targetStorage = await deps.storages.select()

  if (sourceMatter.dirtype === DirType.FILE) {
    const newMatter = await saveFile(
      deps,
      sourceMatter,
      sourceStorage,
      targetStorage,
      currentUserId,
      targetParent,
      createdBy,
    )
    return { saved: [newMatter], skipped: [] }
  }

  return saveFolderRecursive(deps, sourceMatter, sourceStorage, targetStorage, currentUserId, targetParent, createdBy)
}
