import { DirType } from '@shared/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  abortUpload,
  completeUpload,
  copyObject,
  createObject,
  deleteObject,
  getObject,
  getTrashObject,
  listObjects,
  listTrashedObjects,
  type ObjectActor,
  presignUploadSessionParts,
  restoreObject,
  trashObject,
  UPLOAD_PRESIGNED_URL_TTL_SECONDS,
  updateObject,
} from './object'
import {
  AppError,
  type ConflictPlan,
  type Matter,
  type MatterRepo,
  type ObjectUploadSessionRecord,
  type ObjectUploadSessionRepo,
  type S3Gateway,
  type ShareRepo,
  type StorageRecord,
  type StorageRepo,
  type StorageUsageRepo,
} from './ports'

const storage = { id: 'st-1' } as unknown as StorageRecord

// Fixed so two file() calls compare equal (tests deep-equal a fixture against a
// usecase result; argless new Date() per call would flake under load).
const FIXED_DATE = new Date('2024-01-01T00:00:00.000Z')

function file(id: string, overrides: Partial<Matter> = {}): Matter {
  return {
    id,
    alias: `${id}-alias`,
    name: `${id}.txt`,
    type: 'text/plain',
    size: 100,
    dirtype: DirType.FILE,
    parent: '',
    object: `key/${id}`,
    storageId: 'st-1',
    status: 'active',
    trashedAt: null,
    purgedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...overrides,
  }
}

const folder = (id: string, overrides: Partial<Matter> = {}): Matter =>
  file(id, { dirtype: DirType.USER_FOLDER, size: 0, object: '', ...overrides })

const user: ObjectActor = { kind: 'user', userId: 'u1' }

// A permissive default deps; tests override only the ports they exercise.
function makeDeps(
  overrides: {
    matter?: Partial<MatterRepo>
    storages?: Partial<StorageRepo>
    s3?: Partial<S3Gateway>
    storageUsage?: Partial<StorageUsageRepo>
    share?: Partial<ShareRepo>
    objectUploadSessions?: Partial<ObjectUploadSessionRepo>
  } = {},
) {
  const deps = {
    matter: {
      get: async () => null,
      list: async () => ({ items: [], nextBoundary: null }),
      create: async (input: Parameters<MatterRepo['create']>[0]) => file('new', input as Partial<Matter>),
      update: async () => null,
      copy: async (source: Matter, parent: string, object: string) =>
        file('copy', { parent, object, name: source.name }),
      cancelDraft: async () => null,
      trash: async () => null,
      restore: async () => null,
      collectForPurge: async () => null,
      purge: async () => {},
      planConflictResolution: async (_p: string, name: string): Promise<ConflictPlan> => ({
        finalName: name,
        toTrash: null,
      }),
      findActiveConflict: async (parent: string, name: string) => folder('target', { name, parent }),
      commitConflictPlan: async () => {},
      activateDraft: async () => true,
      listTrashedRootPage: async () => ({ items: [], nextBoundary: null }),
      ...overrides.matter,
    } as unknown as MatterRepo,
    storages: {
      get: async () => storage,
      select: async () => storage,
      ...overrides.storages,
    } as unknown as StorageRepo,
    s3: {
      presignUpload: async () => 'https://upload.example',
      presignDownload: async () => 'https://download.example',
      copyObject: async () => {},
      deleteObject: async () => {},
      deleteObjects: async () => {},
      ...overrides.s3,
    } as unknown as S3Gateway,
    storageUsage: {
      reconcile: async () => {},
      rollbackReservations: async () => {},
      ...overrides.storageUsage,
    } as unknown as StorageUsageRepo,
    share: {
      revokeByMatter: async () => {},
      ...overrides.share,
    } as unknown as ShareRepo,
    objectUploadSessions: {
      create: async (input: Parameters<ObjectUploadSessionRepo['create']>[0]) =>
        ({
          id: 'sess-1',
          objectId: input.objectId,
          storageId: input.storageId,
          storageKey: input.storageKey,
          uploadId: input.uploadId,
          partSize: input.partSize,
          status: 'active',
          onConflict: input.onConflict,
          createdBy: input.actorId,
          expiresAt: new Date(Date.now() + 3_600_000),
          createdAt: new Date(),
          updatedAt: new Date(),
        }) as ObjectUploadSessionRecord,
      get: async () => null,
      setStatus: async () => {},
      ...overrides.objectUploadSessions,
    } as unknown as ObjectUploadSessionRepo,
  }
  return { deps }
}

beforeEach(() => vi.clearAllMocks())

function expectError(out: unknown, httpStatus: number, message: string, reason?: string) {
  const e = (out as { ok: false; error: AppError }).error
  expect(e).toBeInstanceOf(AppError)
  expect(e.httpStatus).toBe(httpStatus)
  expect(e.message).toBe(message)
  if (reason) expect(e.meta.reason).toBe(reason)
}

describe('object usecase', () => {
  describe('listObjects', () => {
    it('lists objects for the filters', async () => {
      const item = { ...file('m1'), hasChildren: false }
      const list = vi.fn(async () => ({ items: [item], nextBoundary: null }))
      const { deps } = makeDeps({ matter: { list } })
      const out = await listObjects(deps, {
        filters: { parent: '', pageSize: 20 },
      })
      expect(out).toEqual({ ok: true, result: { items: [item], nextBoundary: null } })
      expect(list).toHaveBeenCalledWith({ parent: '', pageSize: 20 })
    })
  })

  describe('createObject', () => {
    it('rejects a deterministic name conflict before selecting storage', async () => {
      const conflict = file('existing', { parent: '', name: 'same.bin' })
      const planConflictResolution = vi.fn(async () => {
        throw new (await import('./ports')).NameConflictError(conflict.name, conflict.id)
      })
      const select = vi.fn()
      const create = vi.fn()
      const { deps } = makeDeps({
        matter: { planConflictResolution, create },
        storages: { select },
      })

      await expect(
        createObject(deps, {
          actor: user,
          input: { name: 'same.bin', size: 50, dirtype: DirType.FILE, parent: '' },
        }),
      ).rejects.toMatchObject({ name: 'NameConflictError', conflictingId: 'existing' })
      expect(planConflictResolution).toHaveBeenCalledWith('', 'same.bin', 'fail', { isFolder: false })
      expect(select).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    })

    it('rejects unavailable storage before creating rows', async () => {
      const create = vi.fn()
      const createSession = vi.fn()
      const { deps } = makeDeps({
        matter: { create },
        objectUploadSessions: { create: createSession },
        storages: {
          select: async () => {
            throw new Error('No available storage')
          },
        },
      })

      const out = await createObject(deps, {
        actor: user,
        input: { name: 'large.bin', size: 50, dirtype: DirType.FILE, parent: '', storageId: 'missing' },
      })

      expectError(out, 503, 'Storage is not active or has no available capacity', 'NO_STORAGE_CONFIGURED')
      expect(create).not.toHaveBeenCalled()
      expect(createSession).not.toHaveBeenCalled()
    })

    it('creates a folder without presigning an upload', async () => {
      const create = vi.fn(async () => folder('f1', { name: 'My Folder' }))
      const presignUpload = vi.fn()
      const { deps } = makeDeps({ matter: { create }, s3: { presignUpload } })
      const out = await createObject(deps, {
        actor: user,
        input: { name: 'My Folder', type: 'folder', dirtype: DirType.USER_FOLDER, parent: '' },
      })
      expect(out).toEqual({ ok: true, matter: folder('f1', { name: 'My Folder' }) })
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'folder', size: 0, status: 'active', object: '' }),
      )
      expect(presignUpload).not.toHaveBeenCalled()
    })

    it('persists the stable OAuth agent identity on a created object', async () => {
      const create = vi.fn(async () => folder('agent-folder', { name: 'Agent Folder' }))
      const { deps } = makeDeps({ matter: { create } })

      await createObject(deps, {
        actor: {
          kind: 'user',
          userId: 'owner-1',
          identity: { type: 'oauth', ref: 'agent-1', issuer: 'https://realm.example.com' },
        },
        input: { name: 'Agent Folder', type: 'folder', dirtype: DirType.USER_FOLDER, parent: '' },
      })

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          createdByActorType: 'oauth',
          createdByActorRef: 'agent-1',
          createdByActorIssuer: 'https://realm.example.com',
        }),
      )
    })

    it('creates a small file draft and returns single-PUT upload instructions', async () => {
      const create = vi.fn(async (input: Parameters<MatterRepo['create']>[0]) => file('d1', input as Partial<Matter>))
      const presignUpload = vi.fn(async () => 'https://up')
      const { deps } = makeDeps({
        matter: { create },
        s3: { presignUpload },
      })
      const out = await createObject(deps, {
        actor: user,
        input: { name: 'photo.jpg', type: 'image/jpeg', size: 2048, dirtype: DirType.FILE, parent: '' },
      })
      expect(out.ok).toBe(true)
      if (out.ok && 'upload' in out) {
        // Small file → single PutObject: one explicit part, partSize equals the file size.
        expect(out.upload.sessionId).toBe('sess-1')
        expect(out.upload.mode).toBe('single')
        expect(out.upload.uploadId).toBeNull()
        expect(out.upload.partSize).toBe(2048)
        expect(out.upload.partCount).toBe(1)
        expect(out.upload.requiredHeaders).toEqual({ 'content-type': 'image/jpeg' })
        expect(out.upload.urls).toEqual(['https://up'])
        expect(out.upload.parts).toEqual([
          {
            partNumber: 1,
            url: 'https://up',
            expiresAt: out.upload.presignedExpiresAt,
            headers: { 'content-type': 'image/jpeg' },
            offset: 0,
            length: 2048,
          },
        ])
        expect(out.matter.status).toBe('draft')
        expect(out.matter.object).toMatch(/^u1\/\d{8}\/[A-Za-z0-9]{17}\.jpg$/)
        expect(presignUpload).toHaveBeenCalledWith(
          storage,
          out.matter.object,
          'image/jpeg',
          UPLOAD_PRESIGNED_URL_TTL_SECONDS,
        )
      } else {
        throw new Error('expected upload outcome')
      }
    })

    it('presigns and stores a file draft without a content type', async () => {
      const create = vi.fn(async (input: Parameters<MatterRepo['create']>[0]) =>
        file('d1', { ...input, status: 'draft' }),
      )
      const presignUpload = vi.fn(async () => 'https://up')
      const { deps } = makeDeps({ matter: { create }, s3: { presignUpload } })

      const out = await createObject(deps, {
        actor: user,
        input: { name: 'unknown.bin', size: 10, dirtype: DirType.FILE, parent: '' },
      })

      expect(out.ok).toBe(true)
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: '' }))
      expect(presignUpload).toHaveBeenCalledWith(
        storage,
        expect.any(String),
        undefined,
        UPLOAD_PRESIGNED_URL_TTL_SECONDS,
      )
    })

    it('uses an eligible requested storage for a file draft', async () => {
      const target = { ...storage, id: 'st-target' } as StorageRecord
      const select = vi.fn(async () => target)
      const create = vi.fn(async (input: Parameters<MatterRepo['create']>[0]) => file('d1', input as Partial<Matter>))
      const createSession = vi.fn(
        async (input: Parameters<ObjectUploadSessionRepo['create']>[0]) =>
          ({
            id: 'sess-1',
            objectId: input.objectId,
            storageId: input.storageId,
            storageKey: input.storageKey,
            uploadId: input.uploadId,
            partSize: input.partSize,
            status: 'active',
            onConflict: input.onConflict,
            createdBy: input.actorId,
            expiresAt: new Date(Date.now() + 3_600_000),
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as ObjectUploadSessionRecord,
      )
      const { deps } = makeDeps({
        storages: { select },
        matter: { create },
        objectUploadSessions: { create: createSession },
      })

      const out = await createObject(deps, {
        actor: user,
        input: {
          name: 'photo.jpg',
          type: 'image/jpeg',
          size: 1,
          dirtype: DirType.FILE,
          parent: '',
          storageId: 'st-target',
        },
      })

      expect(out.ok).toBe(true)
      expect(select).toHaveBeenCalledWith('st-target')
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ storageId: 'st-target' }))
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ storageId: 'st-target' }))
    })

    it('rejects a requested missing, inactive, or full storage before creating rows', async () => {
      const create = vi.fn()
      const createSession = vi.fn()
      const { deps } = makeDeps({
        matter: { create },
        objectUploadSessions: { create: createSession },
        storages: {
          select: async () => {
            throw new Error('No available storage')
          },
        },
      })

      const out = await createObject(deps, {
        actor: user,
        input: { name: 'x.txt', type: 'text/plain', dirtype: DirType.FILE, parent: '', storageId: 'missing' },
      })

      expectError(out, 503, 'Storage is not active or has no available capacity', 'NO_STORAGE_CONFIGURED')
      expect(create).not.toHaveBeenCalled()
      expect(createSession).not.toHaveBeenCalled()
    })

    it('creates a large file draft and returns multipart upload instructions', async () => {
      const multipartPartSize = 64 * 1024 * 1024
      const size = multipartPartSize + 1
      const draft = file('big', { status: 'draft', object: 'u1/big.bin', name: 'big.bin', size })
      const createMultipartUpload = vi.fn(async () => 'mp-1')
      const presignUploadPart = vi.fn(
        async (_storage: unknown, _key: string, _uploadId: string, partNumber: number) => `https://part-${partNumber}`,
      )
      const { deps } = makeDeps({
        matter: { create: async () => draft },
        s3: { createMultipartUpload, presignUploadPart } as Partial<S3Gateway>,
      })
      const out = await createObject(deps, {
        actor: user,
        input: { name: 'big.bin', type: 'application/octet-stream', size, dirtype: DirType.FILE, parent: '' },
      })
      expect(out.ok).toBe(true)
      if (out.ok && 'upload' in out) {
        expect(out.upload.mode).toBe('multipart')
        expect(out.upload.uploadId).toBe('mp-1')
        expect(out.upload.partSize).toBe(multipartPartSize)
        expect(out.upload.partCount).toBe(2)
        expect(out.upload.requiredHeaders).toEqual({})
        expect(out.upload.urls).toEqual(['https://part-1', 'https://part-2'])
        expect(out.upload.parts).toEqual([
          {
            partNumber: 1,
            url: 'https://part-1',
            expiresAt: out.upload.presignedExpiresAt,
            headers: {},
            offset: 0,
            length: multipartPartSize,
          },
          {
            partNumber: 2,
            url: 'https://part-2',
            expiresAt: out.upload.presignedExpiresAt,
            headers: {},
            offset: multipartPartSize,
            length: 1,
          },
        ])
        expect(createMultipartUpload).toHaveBeenCalled()
        expect(presignUploadPart).toHaveBeenCalledWith(
          storage,
          expect.any(String),
          'mp-1',
          1,
          UPLOAD_PRESIGNED_URL_TTL_SECONDS,
        )
      } else {
        throw new Error('expected upload outcome')
      }
    })

    it('rejects a file larger than 5 TiB before creating a draft', async () => {
      const create = vi.fn()
      const { deps } = makeDeps({ matter: { create } })
      const out = await createObject(deps, {
        actor: user,
        input: {
          name: 'huge.bin',
          type: 'application/octet-stream',
          size: 5 * 1024 * 1024 * 1024 * 1024 + 1,
          dirtype: DirType.FILE,
          parent: '',
        },
      })
      expectError(out, 400, 'File exceeds the 5 TiB maximum', 'FILE_TOO_LARGE')
      expect(create).not.toHaveBeenCalled()
    })

    it('returns no_storage when no storage is configured', async () => {
      const { deps } = makeDeps({
        storages: {
          select: async () => {
            throw new Error('No available storage')
          },
        },
      })
      const out = await createObject(deps, {
        actor: user,
        input: { name: 'x.txt', type: 'text/plain', dirtype: DirType.FILE, parent: '' },
      })
      expectError(out, 503, 'No storage configured', 'NO_STORAGE_CONFIGURED')
    })
  })

  // An active upload session record as the repo returns it. uploadId=null is a
  // single PutObject; a string is an S3 multipart upload.
  function session(overrides: Partial<ObjectUploadSessionRecord> = {}): ObjectUploadSessionRecord {
    return {
      id: 'sess-1',
      objectId: 'd1',
      storageId: 'st-1',
      storageKey: 'key/d1',
      uploadId: null,
      partSize: 100,
      status: 'active',
      onConflict: 'fail',
      createdBy: 'u1',
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as ObjectUploadSessionRecord
  }

  describe('completeUpload', () => {
    it('finalizes a single-PUT draft after HEAD confirms the reported ETag', async () => {
      const draft = file('d1', { status: 'draft', size: 100 })
      const setStatus = vi.fn(async () => {})
      const headObject = vi.fn(async () => ({ size: 100, contentType: 'text/plain', etag: 'abc' }))
      const activateDraft = vi.fn(async () => true)
      const { deps } = makeDeps({
        matter: { get: async () => draft, activateDraft },
        s3: { headObject } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session(), setStatus },
      })
      const out = await completeUpload(deps, {
        objectId: 'd1',
        sessionId: 'sess-1',
        parts: [{ partNumber: 1, etag: 'abc' }],
        actorId: 'u1',
      })
      expect(out.ok).toBe(true)
      if (out.ok) expect(out.matter.status).toBe('active')
      expect(headObject).toHaveBeenCalledWith(storage, 'key/d1')
      expect(setStatus).toHaveBeenCalledWith('sess-1', 'completed')
      expect(activateDraft).toHaveBeenCalledWith('d1', 'd1.txt', 'text/plain', expect.any(Date))
    })

    it('stores an empty type when HEAD returns no Content-Type', async () => {
      const draft = file('d1', { status: 'draft', size: 100, type: 'client/type' })
      const activateDraft = vi.fn(async () => true)
      const { deps } = makeDeps({
        matter: { get: async () => draft, activateDraft },
        s3: { headObject: async () => ({ size: 100, contentType: undefined, etag: 'abc' }) } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session(), setStatus: async () => {} },
      })

      const out = await completeUpload(deps, {
        objectId: 'd1',
        sessionId: 'sess-1',
        parts: [{ partNumber: 1, etag: 'abc' }],
        actorId: 'u1',
      })

      expect(out.ok).toBe(true)
      if (out.ok) expect(out.matter.type).toBe('')
      expect(activateDraft).toHaveBeenCalledWith('d1', 'd1.txt', '', expect.any(Date))
    })

    it('tolerates quoted ETags from the client (strips quotes before comparing)', async () => {
      const draft = file('d1', { status: 'draft', size: 100 })
      const { deps } = makeDeps({
        matter: { get: async () => draft, activateDraft: async () => true },
        s3: { headObject: async () => ({ size: 100, contentType: 'text/plain', etag: 'abc' }) } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session(), setStatus: async () => {} },
      })
      const out = await completeUpload(deps, {
        objectId: 'd1',
        sessionId: 'sess-1',
        parts: [{ partNumber: 1, etag: '"abc"' }],
        actorId: 'u1',
      })
      expect(out.ok).toBe(true)
    })

    it('rejects a single-PUT completion whose ETag does not match the HEAD', async () => {
      const draft = file('d1', { status: 'draft', size: 100 })
      const { deps } = makeDeps({
        matter: { get: async () => draft },
        s3: { headObject: async () => ({ size: 100, contentType: 'text/plain', etag: 'real' }) } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session(), setStatus: async () => {} },
      })
      await expect(
        completeUpload(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          parts: [{ partNumber: 1, etag: 'wrong' }],
          actorId: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' })
    })

    it('completes a multipart draft via CompleteMultipartUpload', async () => {
      const draft = file('d1', { status: 'draft', size: 100 })
      const completeMultipartUpload = vi.fn(async () => {})
      const headObject = vi.fn(async () => ({ size: 100, contentType: 'audio/flac', etag: 'multipart-etag' }))
      const activateDraft = vi.fn(async () => true)
      const { deps } = makeDeps({
        matter: { get: async () => draft, activateDraft },
        s3: { completeMultipartUpload, headObject } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ uploadId: 'mp-1' }), setStatus: async () => {} },
      })
      const out = await completeUpload(deps, {
        objectId: 'd1',
        sessionId: 'sess-1',
        parts: [{ partNumber: 1, etag: 'e1' }],
        actorId: 'u1',
      })
      expect(out.ok).toBe(true)
      expect(completeMultipartUpload).toHaveBeenCalledWith(storage, 'key/d1', 'mp-1', [{ partNumber: 1, etag: 'e1' }])
      expect(headObject).toHaveBeenCalledWith(storage, 'key/d1')
      expect(activateDraft).toHaveBeenCalledWith('d1', 'd1.txt', 'audio/flac', expect.any(Date))
    })

    it('retries a multipart activation race without completing S3 again', async () => {
      const draft = file('d1', { status: 'draft', size: 100 })
      let sessionStatus: ObjectUploadSessionRecord['status'] = 'active'
      let activationAttempts = 0
      const completeMultipartUpload = vi.fn(async () => {})
      const setStatus = vi.fn(async (_id: string, status: ObjectUploadSessionRecord['status']) => {
        sessionStatus = status
      })
      const headObject = vi.fn(async () => ({ size: 100, contentType: 'audio/flac', etag: 'multipart-etag' }))
      const activateDraft = vi.fn(async () => {
        activationAttempts += 1
        return activationAttempts > 1
      })
      const { deps } = makeDeps({
        matter: { get: async () => draft, activateDraft },
        s3: { completeMultipartUpload, headObject } as Partial<S3Gateway>,
        objectUploadSessions: {
          get: async () => session({ status: sessionStatus, uploadId: 'mp-1' }),
          setStatus,
        },
      })

      await expect(
        completeUpload(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          parts: [{ partNumber: 1, etag: 'e1' }],
          actorId: 'u1',
        }),
      ).rejects.toThrow('CONFIRM_UPLOAD_RACE')

      const second = await completeUpload(deps, {
        objectId: 'd1',
        sessionId: 'sess-1',
        parts: [{ partNumber: 1, etag: 'e1' }],
        actorId: 'u1',
      })

      expect(second.ok).toBe(true)
      expect(completeMultipartUpload).toHaveBeenCalledTimes(1)
      expect(setStatus).toHaveBeenCalledTimes(1)
      expect(setStatus).toHaveBeenCalledWith('sess-1', 'completed')
      expect(headObject).toHaveBeenCalledTimes(2)
      expect(activateDraft).toHaveBeenCalledTimes(2)
    })

    it('returns the active object when completion is repeated for an already-completed session', async () => {
      const active = file('d1', { status: 'active' })
      const completeMultipartUpload = vi.fn()
      const headObject = vi.fn()
      const setStatus = vi.fn()
      const { deps } = makeDeps({
        matter: { get: async () => active },
        s3: { completeMultipartUpload, headObject } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ status: 'completed', uploadId: 'mp-1' }), setStatus },
      })

      const out = await completeUpload(deps, {
        objectId: 'd1',
        sessionId: 'sess-1',
        parts: [{ partNumber: 1, etag: 'e1' }],
        actorId: 'u1',
      })

      expect(out).toEqual({ ok: true, matter: active })
      expect(completeMultipartUpload).not.toHaveBeenCalled()
      expect(headObject).not.toHaveBeenCalled()
      expect(setStatus).not.toHaveBeenCalled()
    })

    it('rejects duplicate multipart completion parts before completing storage', async () => {
      const completeMultipartUpload = vi.fn()
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft', size: 200 }) },
        s3: { completeMultipartUpload } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ uploadId: 'mp-1', partSize: 100 }) },
      })

      await expect(
        completeUpload(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          parts: [
            { partNumber: 1, etag: 'e1' },
            { partNumber: 1, etag: 'e1-again' },
          ],
          actorId: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' })
      expect(completeMultipartUpload).not.toHaveBeenCalled()
    })

    it('rejects missing multipart completion parts before completing storage', async () => {
      const completeMultipartUpload = vi.fn()
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft', size: 200 }) },
        s3: { completeMultipartUpload } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ uploadId: 'mp-1', partSize: 100 }) },
      })

      await expect(
        completeUpload(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          parts: [{ partNumber: 1, etag: 'e1' }],
          actorId: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' })
      expect(completeMultipartUpload).not.toHaveBeenCalled()
    })

    it('rejects an expired upload session before completing storage', async () => {
      const completeMultipartUpload = vi.fn()
      const headObject = vi.fn()
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft' }) },
        s3: { completeMultipartUpload, headObject } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ expiresAt: new Date(Date.now() - 1_000) }) },
      })

      await expect(
        completeUpload(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          parts: [{ partNumber: 1, etag: 'e1' }],
          actorId: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' })
      expect(completeMultipartUpload).not.toHaveBeenCalled()
      expect(headObject).not.toHaveBeenCalled()
    })

    it('throws not_found when the upload session is missing', async () => {
      const draft = file('d1', { status: 'draft' })
      const { deps } = makeDeps({
        matter: { get: async () => draft },
        objectUploadSessions: { get: async () => null },
      })
      await expect(
        completeUpload(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          parts: [{ partNumber: 1, etag: 'x' }],
          actorId: 'u1',
        }),
      ).rejects.toMatchObject({ code: 'not_found' })
    })

    it('propagates a name conflict thrown during activation', async () => {
      const draft = file('d1', { status: 'draft' })
      const { deps } = makeDeps({
        matter: {
          get: async () => draft,
          planConflictResolution: async () => {
            throw new (await import('./ports')).NameConflictError('upload.txt', 'active1')
          },
        },
        s3: { headObject: async () => ({ size: 100, contentType: 'text/plain', etag: 'abc' }) } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session(), setStatus: async () => {} },
      })
      await expect(
        completeUpload(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          parts: [{ partNumber: 1, etag: 'abc' }],
          actorId: 'u1',
        }),
      ).rejects.toMatchObject({ name: 'NameConflictError' })
    })
  })

  describe('presignUploadSessionParts', () => {
    it('re-signs bounded explicit multipart part numbers with expiry metadata', async () => {
      const presignUploadPart = vi.fn(
        async (_storage: unknown, _key: string, _uploadId: string, partNumber: number) => `https://part-${partNumber}`,
      )
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft', size: 250 }) },
        s3: { presignUploadPart } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ uploadId: 'mp-1', partSize: 100 }) },
      })

      const out = await presignUploadSessionParts(deps, {
        objectId: 'd1',
        sessionId: 'sess-1',
        partNumbers: [3, 1],
      })

      expect(out.mode).toBe('multipart')
      expect(out.uploadId).toBe('mp-1')
      expect(out.partCount).toBe(3)
      expect(out.parts).toEqual([
        {
          partNumber: 3,
          url: 'https://part-3',
          expiresAt: out.presignedExpiresAt,
          headers: {},
          offset: 200,
          length: 50,
        },
        {
          partNumber: 1,
          url: 'https://part-1',
          expiresAt: out.presignedExpiresAt,
          headers: {},
          offset: 0,
          length: 100,
        },
      ])
      expect(presignUploadPart).toHaveBeenCalledWith(storage, 'key/d1', 'mp-1', 3, UPLOAD_PRESIGNED_URL_TTL_SECONDS)
    })

    it('re-signs a single-PUT session with required headers for interrupted resume', async () => {
      const presignUpload = vi.fn(async () => 'https://single-resigned')
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft', size: 100, type: 'text/plain' }) },
        s3: { presignUpload } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ uploadId: null, partSize: 100 }) },
      })

      const out = await presignUploadSessionParts(deps, {
        objectId: 'd1',
        sessionId: 'sess-1',
        partNumbers: [1],
      })

      expect(out).toMatchObject({
        uploadId: null,
        mode: 'single',
        partSize: 100,
        partCount: 1,
        requiredHeaders: { 'content-type': 'text/plain' },
        parts: [{ partNumber: 1, url: 'https://single-resigned', headers: { 'content-type': 'text/plain' } }],
      })
      expect(out.parts[0]?.expiresAt).toBe(out.presignedExpiresAt)
      expect(presignUpload).toHaveBeenCalledWith(storage, 'key/d1', 'text/plain', UPLOAD_PRESIGNED_URL_TTL_SECONDS)
    })

    it('rejects duplicate re-sign part numbers before signing', async () => {
      const presignUploadPart = vi.fn()
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft', size: 300 }) },
        s3: { presignUploadPart } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ uploadId: 'mp-1', partSize: 100 }) },
      })

      await expect(
        presignUploadSessionParts(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          partNumbers: [2, 2],
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' })
      expect(presignUploadPart).not.toHaveBeenCalled()
    })

    it('rejects re-sign part numbers outside the session part count before signing', async () => {
      const presignUploadPart = vi.fn()
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft', size: 300 }) },
        s3: { presignUploadPart } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ uploadId: 'mp-1', partSize: 100 }) },
      })

      await expect(
        presignUploadSessionParts(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          partNumbers: [4],
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' })
      expect(presignUploadPart).not.toHaveBeenCalled()
    })

    it('rejects re-sign for expired sessions before signing', async () => {
      const presignUploadPart = vi.fn()
      const expired = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft', size: 300 }) },
        s3: { presignUploadPart } as Partial<S3Gateway>,
        objectUploadSessions: {
          get: async () => session({ uploadId: 'mp-1', partSize: 100, expiresAt: new Date(Date.now() - 1_000) }),
        },
      })
      await expect(
        presignUploadSessionParts(expired.deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          partNumbers: [1],
        }),
      ).rejects.toMatchObject({ code: 'invalid_state' })
      expect(presignUploadPart).not.toHaveBeenCalled()
    })
  })

  describe('abortUpload', () => {
    it('aborts a single-PUT session: best-effort S3 delete + discards the draft', async () => {
      const setStatus = vi.fn(async () => {})
      const cancelDraft = vi.fn(async () => file('d1', { status: 'draft' }))
      const deleteObjectFn = vi.fn(async () => {})
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft' }), cancelDraft },
        s3: { deleteObject: deleteObjectFn },
        objectUploadSessions: { get: async () => session(), setStatus },
      })
      await abortUpload(deps, { objectId: 'd1', sessionId: 'sess-1', actorId: 'u1' })
      expect(deleteObjectFn).toHaveBeenCalledWith(storage, 'key/d1')
      expect(setStatus).toHaveBeenCalledWith('sess-1', 'aborted')
      expect(cancelDraft).toHaveBeenCalledWith('d1')
    })

    it('strict single-PUT abort fails when S3 cleanup fails', async () => {
      const setStatus = vi.fn()
      const cancelDraft = vi.fn()
      const deleteObjectFn = vi.fn(async () => {
        throw new Error('delete denied')
      })
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft' }), cancelDraft },
        s3: { deleteObject: deleteObjectFn },
        objectUploadSessions: { get: async () => session(), setStatus },
      })

      await expect(
        abortUpload(deps, {
          objectId: 'd1',
          sessionId: 'sess-1',
          actorId: 'u1',
          strictStorageCleanup: true,
        }),
      ).rejects.toMatchObject({ name: 'ObjectUploadSessionError', code: 'storage_failure' })
      expect(setStatus).not.toHaveBeenCalled()
      expect(cancelDraft).not.toHaveBeenCalled()
    })

    it('aborts a multipart session via AbortMultipartUpload', async () => {
      const abortMultipartUpload = vi.fn(async () => {})
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft' }), cancelDraft: async () => file('d1') },
        s3: { abortMultipartUpload } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ uploadId: 'mp-1' }), setStatus: async () => {} },
      })
      await abortUpload(deps, { objectId: 'd1', sessionId: 'sess-1', actorId: 'u1' })
      expect(abortMultipartUpload).toHaveBeenCalledWith(storage, 'key/d1', 'mp-1')
    })

    it('abandons a completed multipart draft by deleting the finalized object', async () => {
      const deleteObjectFn = vi.fn(async () => {})
      const abortMultipartUpload = vi.fn()
      const setStatus = vi.fn(async () => {})
      const cancelDraft = vi.fn(async () => file('d1', { status: 'draft' }))
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft' }), cancelDraft },
        s3: { deleteObject: deleteObjectFn, abortMultipartUpload } as Partial<S3Gateway>,
        objectUploadSessions: { get: async () => session({ status: 'completed', uploadId: 'mp-1' }), setStatus },
      })

      await abortUpload(deps, { objectId: 'd1', sessionId: 'sess-1', actorId: 'u1' })

      expect(deleteObjectFn).toHaveBeenCalledWith(storage, 'key/d1')
      expect(abortMultipartUpload).not.toHaveBeenCalled()
      expect(setStatus).toHaveBeenCalledWith('sess-1', 'aborted')
      expect(cancelDraft).toHaveBeenCalledWith('d1')
    })

    it('finishes draft cancellation when retrying an already-aborted session', async () => {
      const cancelDraft = vi.fn(async () => null)
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft' }), cancelDraft },
        objectUploadSessions: { get: async () => session({ status: 'aborted' }) },
      })
      await abortUpload(deps, { objectId: 'd1', sessionId: 'sess-1', actorId: 'u1' })
      expect(cancelDraft).toHaveBeenCalledWith('d1')
    })

    it('returns successfully for an already-aborted session whose draft was already deleted', async () => {
      const cancelDraft = vi.fn()
      const { deps } = makeDeps({
        matter: { get: async () => null, cancelDraft },
        objectUploadSessions: { get: async () => session({ status: 'aborted' }) },
      })
      await abortUpload(deps, { objectId: 'd1', sessionId: 'sess-1', actorId: 'u1' })
      expect(cancelDraft).not.toHaveBeenCalled()
    })

    it('is idempotent for an already-aborted non-draft session', async () => {
      const cancelDraft = vi.fn(async () => null)
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'cancelled' }), cancelDraft },
        objectUploadSessions: { get: async () => session({ status: 'aborted' }) },
      })
      await abortUpload(deps, { objectId: 'd1', sessionId: 'sess-1', actorId: 'u1' })
      expect(cancelDraft).not.toHaveBeenCalled()
    })

    it('recovers when completed draft abort marked aborted before draft cancellation failed', async () => {
      let status: ObjectUploadSessionRecord['status'] = 'completed'
      let cancelAttempts = 0
      const deleteObjectFn = vi.fn(async () => {})
      const setStatus = vi.fn(async (_id: string, next: ObjectUploadSessionRecord['status']) => {
        status = next
      })
      const cancelDraft = vi.fn(async () => {
        cancelAttempts += 1
        if (cancelAttempts === 1) throw new Error('db write failed')
        return file('d1', { status: 'draft' })
      })
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'draft' }), cancelDraft },
        s3: { deleteObject: deleteObjectFn },
        objectUploadSessions: { get: async () => session({ status, uploadId: 'mp-1' }), setStatus },
      })

      await expect(abortUpload(deps, { objectId: 'd1', sessionId: 'sess-1', actorId: 'u1' })).rejects.toThrow(
        'db write failed',
      )
      await abortUpload(deps, { objectId: 'd1', sessionId: 'sess-1', actorId: 'u1' })

      expect(deleteObjectFn).toHaveBeenCalledTimes(1)
      expect(setStatus).toHaveBeenCalledWith('sess-1', 'aborted')
      expect(cancelDraft).toHaveBeenCalledTimes(2)
      expect(cancelDraft).toHaveBeenLastCalledWith('d1')
    })

    it('rejects aborting an already-completed active session', async () => {
      const deleteObjectFn = vi.fn()
      const cancelDraft = vi.fn()
      const { deps } = makeDeps({
        matter: { get: async () => file('d1', { status: 'active' }), cancelDraft },
        s3: { deleteObject: deleteObjectFn },
        objectUploadSessions: { get: async () => session({ status: 'completed' }) },
      })
      await expect(abortUpload(deps, { objectId: 'd1', sessionId: 'sess-1', actorId: 'u1' })).rejects.toMatchObject({
        code: 'invalid_state',
      })
      expect(deleteObjectFn).not.toHaveBeenCalled()
      expect(cancelDraft).not.toHaveBeenCalled()
    })
  })

  describe('listTrashedObjects / getTrashObject', () => {
    it('paginates trashed roots', async () => {
      const roots = [file('t1', { trashedAt: 2 }), file('t2', { trashedAt: 1 })]
      const nextBoundary = { trashedAt: 2, createdAt: roots[0]!.createdAt, id: 't1' }
      const listTrashedRootPage = vi.fn(async () => ({ items: [roots[0]!], nextBoundary }))
      const { deps } = makeDeps({ matter: { listTrashedRootPage } })
      const out = await listTrashedObjects(deps, { pageSize: 1 })
      expect(out.result.items).toEqual([roots[0]])
      expect(out.result.nextBoundary).toEqual(nextBoundary)
      expect(listTrashedRootPage).toHaveBeenCalledWith({ pageSize: 1, after: undefined })
    })

    it('returns a trashed object', async () => {
      const { deps } = makeDeps({ matter: { get: async () => file('t1', { trashedAt: 5 }) } })
      const out = await getTrashObject(deps, { objectId: 't1' })
      expect(out.ok).toBe(true)
      if (out.ok) expect(out.matter.trashedAt).toBe(5)
    })

    it('returns not_found for a live (non-trashed) object', async () => {
      const { deps } = makeDeps({ matter: { get: async () => file('m1', { trashedAt: null }) } })
      expectError(await getTrashObject(deps, { objectId: 'm1' }), 404, 'Not found')
    })

    it('returns not_found for a missing object', async () => {
      const { deps } = makeDeps({ matter: { get: async () => null } })
      expectError(await getTrashObject(deps, { objectId: 'x' }), 404, 'Not found')
    })
  })

  describe('getObject', () => {
    it('returns a folder without presigning', async () => {
      const presignDownload = vi.fn()
      const { deps } = makeDeps({ matter: { get: async () => folder('f1') }, s3: { presignDownload } })
      const out = await getObject(deps, { objectId: 'f1' })
      expect(out).toEqual({ ok: true, matter: folder('f1') })
      expect(presignDownload).not.toHaveBeenCalled()
    })

    it('returns not_found for a missing object', async () => {
      const { deps } = makeDeps({ matter: { get: async () => null } })
      const out = await getObject(deps, { objectId: 'x' })
      expectError(out, 404, 'Not found')
    })

    it('returns storage_not_found when a file has no storage row', async () => {
      const { deps } = makeDeps({ matter: { get: async () => file('m1') }, storages: { get: async () => null } })
      const out = await getObject(deps, { objectId: 'm1' })
      expectError(out, 404, 'Storage not found')
    })

    it('presigns the download URL for a file', async () => {
      const presignDownload = vi.fn(async () => 'https://signed')
      const { deps } = makeDeps({
        matter: { get: async () => file('m1', { size: 100 }) },
        s3: { presignDownload },
      })
      const out = await getObject(deps, { objectId: 'm1' })
      expect(out).toMatchObject({ ok: true, downloadUrl: 'https://signed' })
      expect(presignDownload).toHaveBeenCalledWith(storage, 'key/m1', 'm1.txt')
    })

    it('propagates a presign failure', async () => {
      const { deps } = makeDeps({
        matter: { get: async () => file('m1', { size: 250 }) },
        s3: {
          presignDownload: async () => {
            throw new Error('sign failed')
          },
        },
      })
      await expect(getObject(deps, { objectId: 'm1' })).rejects.toThrow('sign failed')
    })
  })

  describe('updateObject', () => {
    it('renames and returns the matter', async () => {
      const update = vi.fn(async () => file('m1', { name: 'New.txt' }))
      const { deps } = makeDeps({ matter: { get: async () => file('m1'), update } })
      const out = await updateObject(deps, {
        objectId: 'm1',
        input: { name: 'New.txt' },
      })
      expect(out).toEqual({ ok: true, matter: file('m1', { name: 'New.txt' }) })
      expect(update).toHaveBeenCalledWith('m1', { name: 'New.txt', parent: undefined, onConflict: undefined })
    })

    it('returns not_found when the matter is missing', async () => {
      const { deps } = makeDeps({ matter: { update: async () => null } })
      const out = await updateObject(deps, {
        objectId: 'x',
        input: { name: 'X' },
      })
      expectError(out, 404, 'Not found')
    })
  })

  describe('trashObject / restoreObject', () => {
    it('trashes a matter', async () => {
      // Trash = active row with trashedAt set (no 'trashed' status).
      const { deps } = makeDeps({
        matter: {
          get: async () => file('m1'),
          trash: async () => file('m1', { status: 'active', trashedAt: 1 }),
        },
      })
      const out = await trashObject(deps, { objectId: 'm1' })
      expect(out.ok).toBe(true)
      if (out.ok) {
        expect(out.matter.status).toBe('active')
        expect(out.matter.trashedAt).toBe(1)
      }
    })

    it('trash returns not_found when missing', async () => {
      const { deps } = makeDeps({ matter: { trash: async () => null } })
      expectError(await trashObject(deps, { objectId: 'x' }), 404, 'Not found')
    })

    it('restores with the default fail strategy', async () => {
      const restore = vi.fn(async () => file('m1', { status: 'active' }))
      const { deps } = makeDeps({ matter: { restore } })
      const out = await restoreObject(deps, { objectId: 'm1' })
      expect(out.ok).toBe(true)
      expect(restore).toHaveBeenCalledWith('m1', 'fail')
    })

    it('restore passes the given onConflict strategy', async () => {
      const restore = vi.fn(async () => file('m1', { status: 'active' }))
      const { deps } = makeDeps({ matter: { restore } })
      await restoreObject(deps, { objectId: 'm1', onConflict: 'rename' })
      expect(restore).toHaveBeenCalledWith('m1', 'rename')
    })

    it('restore returns not_found when missing', async () => {
      const { deps } = makeDeps({ matter: { restore: async () => null } })
      expectError(await restoreObject(deps, { objectId: 'x' }), 404, 'Not found')
    })
  })

  describe('deleteObject (purge)', () => {
    it('purges a trashed subtree, revoking shares and reconciling usage', async () => {
      const subtree = [folder('f1', { trashedAt: 1 }), file('m1', { trashedAt: 1, parent: 'f1' })]
      const purge = vi.fn(async () => {})
      const deleteObjects = vi.fn(async () => {})
      const revokeByMatter = vi.fn(async () => {})
      const reconcile = vi.fn(async () => {})
      const { deps } = makeDeps({
        matter: { collectForPurge: async () => subtree, purge },
        s3: { deleteObjects },
        share: { revokeByMatter },
        storageUsage: { reconcile },
      })
      const out = await deleteObject(deps, { objectId: 'f1' })
      expect(out).toEqual({ ok: true, id: 'f1', purged: 2 })
      expect(purge).toHaveBeenCalledWith(['f1', 'm1'])
      expect(revokeByMatter).toHaveBeenCalledWith('f1')
      expect(revokeByMatter).toHaveBeenCalledWith('m1')
      expect(deleteObjects).toHaveBeenCalled()
      expect(reconcile).toHaveBeenCalledWith(new Set(['st-1']))
    })

    it('returns not_found when the object does not exist', async () => {
      const { deps } = makeDeps({
        matter: { collectForPurge: (async () => null) as unknown as MatterRepo['collectForPurge'] },
      })
      expect(await deleteObject(deps, { objectId: 'x' })).toEqual({
        ok: false,
        reason: 'not_found',
      })
    })

    it('returns not_trashed when the object is still active', async () => {
      const { deps } = makeDeps({
        matter: { collectForPurge: async () => [folder('f1', { status: 'active' })] },
      })
      const out = await deleteObject(deps, { objectId: 'f1' })
      expect(out).toEqual({ ok: false, reason: 'not_trashed' })
    })
  })

  describe('copyObject', () => {
    it('copies the S3 object and creates the matter', async () => {
      const source = file('src', { size: 200, object: 'legacy_/source-file-.txt' })
      const copyObjectS3 = vi.fn(async (..._args: Parameters<S3Gateway['copyObject']>) => {})
      const copy = vi.fn(async () => file('cp', { parent: 'Dest', name: source.name }))
      const { deps } = makeDeps({
        matter: { get: async () => source, copy },
        s3: { copyObject: copyObjectS3 },
      })
      const out = await copyObject(deps, { userId: 'u1', input: { copyFrom: 'src', parent: 'Dest' } })
      expect(out.ok).toBe(true)
      const destinationKey = copyObjectS3.mock.calls[0]?.[3]
      expect(source.object).toBe('legacy_/source-file-.txt')
      expect(destinationKey).toMatch(/^u1\/\d{8}\/[A-Za-z0-9]{17}\.txt$/)
      expect(copyObjectS3).toHaveBeenCalledWith(storage, source.object, storage, destinationKey)
      expect(copy).toHaveBeenCalledWith(source, 'Dest', destinationKey, {
        onConflict: undefined,
        createdByActorType: 'user',
        createdByActorRef: 'u1',
        createdByActorIssuer: null,
      })
    })

    it('returns not_found for a missing source', async () => {
      const { deps } = makeDeps({ matter: { get: async () => null } })
      expectError(await copyObject(deps, { userId: 'u1', input: { copyFrom: 'x', parent: '' } }), 404, 'Not found')
    })

    it('returns storage_not_found for an object-backed source with no storage', async () => {
      const source = file('src', { object: 'key/src' })
      const { deps } = makeDeps({ matter: { get: async () => source }, storages: { get: async () => null } })
      const out = await copyObject(deps, { userId: 'u1', input: { copyFrom: 'src', parent: '' } })
      expectError(out, 404, 'Storage not found')
    })

    it('rolls back the S3 copy when the matter copy fails', async () => {
      const source = file('src', { size: 200, object: 'key/src' })
      const deleteObjectFn = vi.fn(async () => {})
      const { deps } = makeDeps({
        matter: {
          get: async () => source,
          copy: async () => {
            throw new Error('copy failed')
          },
        },
        s3: { copyObject: async () => {}, deleteObject: deleteObjectFn },
      })
      await expect(copyObject(deps, { userId: 'u1', input: { copyFrom: 'src', parent: '' } })).rejects.toThrow(
        'copy failed',
      )
      // onRollback deletes the freshly copied S3 object.
      expect(deleteObjectFn).toHaveBeenCalled()
    })
  })
})
