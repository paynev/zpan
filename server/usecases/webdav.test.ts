import { DirType } from '@shared/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../platform/interface'
import type {
  ApiKeyAuth,
  ApiKeyGateway,
  DavLock,
  Matter,
  MatterRepo,
  S3Gateway,
  StorageRecord,
  StorageRepo,
  StorageUsageRepo,
  WebDavPathRepo,
  WebDavStateRepo,
  WebDavTarget,
  WebDavWorkspace,
} from './ports'
import { ApiKeyRateLimitError, NameConflictError } from './ports'
import {
  applyWebDavDeadProperties,
  copyWebDavCollection,
  copyWebDavFile,
  createWebDavCollection,
  createWebDavLock,
  deleteWebDavMatter,
  ensureParentCollection,
  moveWebDavMatter,
  putWebDavFile,
  resolveWebDavAuth,
  resolveWebDavDownload,
} from './webdav'

const storage = { id: 'st-1' } as unknown as StorageRecord

const workspace: WebDavWorkspace = {
  id: 'ws-1',
  name: 'Workspace',
  slug: 'workspace',
  pathSegment: 'workspace',
}

function file(id: string, overrides: Partial<Matter> = {}): Matter {
  return {
    id,
    alias: `${id}-alias`,
    name: `${id}.txt`,
    type: 'text/plain',
    size: 100,
    dirtype: DirType.FILE,
    parent: '',
    object: `objects/${id}.txt`,
    storageId: 'st-1',
    status: 'active',
    trashedAt: null,
    purgedAt: null,
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-01'),
    ...overrides,
  }
}

const folder = (id: string, overrides: Partial<Matter> = {}): Matter =>
  file(id, { dirtype: DirType.USER_FOLDER, size: 0, object: '', type: 'folder', ...overrides })

function target(overrides: Partial<WebDavTarget> = {}): WebDavTarget {
  return { workspace, mountRoot: false, parent: '', name: 'new.txt', matter: null, ...overrides }
}

const lock: DavLock = {
  id: 'lk-1',
  token: 'opaquelocktoken:abc',
  resourcePath: 'new.txt',
  owner: 'tester',
  depth: '0',
  expiresAt: new Date(Date.now() + 3600_000),
  createdAt: new Date(),
  updatedAt: new Date(),
}

// A permissive default deps; tests override only the ports they exercise.
function makeDeps(
  overrides: {
    apiKeys?: Partial<ApiKeyGateway>
    matter?: Partial<MatterRepo>
    storages?: Partial<StorageRepo>
    s3?: Partial<S3Gateway>
    storageUsage?: Partial<StorageUsageRepo>
    webdavPath?: Partial<WebDavPathRepo>
    webdavState?: Partial<WebDavStateRepo>
  } = {},
) {
  const deps = {
    apiKeys: {
      verifyApiKeyForPermission: async () => ({ id: 'k1', configId: 'webdav', referenceId: 'u1', permissions: null }),
      hasApiKeyPermission: async () => true,
      ...overrides.apiKeys,
    } as unknown as ApiKeyGateway,
    matter: {
      create: async (input: Parameters<MatterRepo['create']>[0]) => file('new', input as Partial<Matter>),
      copy: async (source: Matter, parent: string, object: string) =>
        file('copy', { parent, object, name: source.name }),
      update: async () => file('m1'),
      trash: async () => file('m1', { trashedAt: Date.now() }),
      trashByIds: async () => {},
      restoreActiveByIds: async () => {},
      touch: async () => {},
      applyUpload: async () => {},
      listActiveDescendants: async () => [],
      get: async () => null,
      ...overrides.matter,
    } as unknown as MatterRepo,
    storages: {
      get: async () => storage,
      select: async () => storage,
      ...overrides.storages,
    } as unknown as StorageRepo,
    s3: {
      getObjectBody: async () => new Uint8Array(),
      putObject: async (_s: unknown, _k: unknown, body: unknown, _t: unknown, len?: number) =>
        len ?? (body instanceof Uint8Array ? body.byteLength : 0),
      copyObject: async () => {},
      deleteObject: async () => {},
      ...overrides.s3,
    } as unknown as S3Gateway,
    storageUsage: {
      reconcile: async () => {},
      rollbackReservations: async () => {},
      ...overrides.storageUsage,
    } as unknown as StorageUsageRepo,
    webdavPath: {
      resolveWebDavPath: async () => target(),
      resolveExistingWebDavPath: async () => target(),
      listChildren: async () => [],
      listUserWorkspaces: async () => [workspace],
      ...overrides.webdavPath,
    } as unknown as WebDavPathRepo,
    webdavState: {
      activeLocks: async () => [],
      activeLocksForResources: async () => new Map(),
      listDeadPropertiesForResources: async () => new Map(),
      conflictingLocks: async () => [],
      applyDeadPropertyUpdate: async () => {},
      copyDeadProperties: async () => {},
      deleteWebDavState: async () => {},
      moveWebDavState: async () => {},
      createLock: async () => lock,
      tryCreateLock: async () => lock,
      refreshLock: async () => lock,
      removeLock: async () => true,
      purgeExpiredLocks: async () => {},
      ...overrides.webdavState,
    } as unknown as WebDavStateRepo,
  }
  return deps
}

const authParams = {
  auth: {} as ApiKeyAuth,
  db: {} as Database,
  password: 'secret',
  requiredScopes: [{ resource: 'objects', action: 'read' }],
  configId: 'webdav',
}

beforeEach(() => vi.clearAllMocks())

describe('webdav usecase', () => {
  describe('resolveWebDavAuth', () => {
    it('resolves the userId from the key referenceId when the key verifies [spec: webdav/auth]', async () => {
      const verifyApiKeyForPermission = vi.fn(async () => ({
        id: 'k1',
        configId: 'webdav',
        referenceId: 'u9',
        scope: { mode: 'user-workspaces' as const },
        permissions: null,
      }))
      const deps = makeDeps({ apiKeys: { verifyApiKeyForPermission } })
      const out = await resolveWebDavAuth(deps, authParams)
      expect(out).toEqual({ ok: true, userId: 'u9', keyId: 'k1', configId: 'webdav', permissions: null })
      expect(verifyApiKeyForPermission).toHaveBeenCalledWith({}, {}, 'secret', 'objects', 'read', 'webdav')
    })

    it('is unauthorized when the key does not verify [spec: webdav/auth]', async () => {
      const deps = makeDeps({ apiKeys: { verifyApiKeyForPermission: async () => null } })
      expect(await resolveWebDavAuth(deps, authParams)).toEqual({ ok: false, reason: 'unauthorized' })
    })

    it('is unauthorized when no scopes are required', async () => {
      const deps = makeDeps()
      expect(await resolveWebDavAuth(deps, { ...authParams, requiredScopes: [] })).toEqual({
        ok: false,
        reason: 'unauthorized',
      })
    })

    it('surfaces a rate-limit with its retry window', async () => {
      const deps = makeDeps({
        apiKeys: {
          verifyApiKeyForPermission: async () => {
            throw new ApiKeyRateLimitError('slow down', 5000)
          },
        },
      })
      expect(await resolveWebDavAuth(deps, authParams)).toEqual({
        ok: false,
        reason: 'rate_limited',
        retryAfterMs: 5000,
        message: 'slow down',
      })
    })

    it('treats any other verification error as unauthorized', async () => {
      const deps = makeDeps({
        apiKeys: {
          verifyApiKeyForPermission: async () => {
            throw new Error('boom')
          },
        },
      })
      expect(await resolveWebDavAuth(deps, authParams)).toEqual({ ok: false, reason: 'unauthorized' })
    })
  })

  describe('ensureParentCollection', () => {
    it('is a no-op for an empty parent', async () => {
      const resolveWebDavPath = vi.fn()
      const deps = makeDeps({ webdavPath: { resolveWebDavPath } })
      await ensureParentCollection(deps, { userId: 'u1', workspaceSlug: 'workspace', parent: '' })
      expect(resolveWebDavPath).not.toHaveBeenCalled()
    })

    it('throws 409 when the parent collection does not exist [spec: webdav/mkcol-guards]', async () => {
      const deps = makeDeps({ webdavPath: { resolveWebDavPath: async () => target({ matter: null }) } })
      await expect(
        ensureParentCollection(deps, { userId: 'u1', workspaceSlug: 'workspace', parent: 'Missing' }),
      ).rejects.toMatchObject({ status: 409 })
    })

    it('throws 405 when the parent resolves to a file [spec: webdav/mkcol-guards]', async () => {
      const deps = makeDeps({ webdavPath: { resolveWebDavPath: async () => target({ matter: file('p1') }) } })
      await expect(
        ensureParentCollection(deps, { userId: 'u1', workspaceSlug: 'workspace', parent: 'file.txt' }),
      ).rejects.toMatchObject({ status: 405 })
    })

    it('passes for an existing folder parent [spec: webdav/mkcol-guards]', async () => {
      const deps = makeDeps({ webdavPath: { resolveWebDavPath: async () => target({ matter: folder('p1') }) } })
      await expect(
        ensureParentCollection(deps, { userId: 'u1', workspaceSlug: 'workspace', parent: 'Docs' }),
      ).resolves.toBeUndefined()
    })
  })

  describe('applyWebDavDeadProperties', () => {
    it('applies the update and touches the matter when present', async () => {
      const applyDeadPropertyUpdate = vi.fn(async () => {})
      const touch = vi.fn(async () => {})
      const deps = makeDeps({ webdavState: { applyDeadPropertyUpdate }, matter: { touch } })
      const operations = [
        { action: 'set' as const, property: { namespace: 'urn:x', name: 'color', value: '<color>red</color>' } },
      ]
      await applyWebDavDeadProperties(deps, { resourcePath: 'a.txt', operations, matterId: 'm1' })
      expect(applyDeadPropertyUpdate).toHaveBeenCalledWith('a.txt', operations)
      expect(touch).toHaveBeenCalledWith('m1')
    })

    it('does not touch when there is no matter (workspace root)', async () => {
      const touch = vi.fn(async () => {})
      const deps = makeDeps({ matter: { touch } })
      await applyWebDavDeadProperties(deps, { resourcePath: '', operations: [], matterId: null })
      expect(touch).not.toHaveBeenCalled()
    })
  })

  describe('resolveWebDavDownload', () => {
    it('returns not_found when the matter is missing', async () => {
      const deps = makeDeps({
        webdavPath: { resolveExistingWebDavPath: async () => target({ matter: null, name: 'missing.txt' }) },
      })
      expect(await resolveWebDavDownload(deps, { userId: 'u1', rawPath: '/dav/workspace/missing.txt' })).toEqual({
        ok: false,
        reason: 'not_found',
      })
    })

    it('returns workspace_not_found when no workspace resolves', async () => {
      const deps = makeDeps({
        webdavPath: {
          resolveExistingWebDavPath: async () => ({ ...target({ matter: file('m1') }), workspace: null }),
        },
      })
      expect(await resolveWebDavDownload(deps, { userId: 'u1', rawPath: '/dav/x' })).toEqual({
        ok: false,
        reason: 'workspace_not_found',
      })
    })

    it('returns not_a_file for a collection', async () => {
      const deps = makeDeps({
        webdavPath: { resolveExistingWebDavPath: async () => target({ matter: folder('d1') }) },
      })
      expect(await resolveWebDavDownload(deps, { userId: 'u1', rawPath: '/dav/workspace/d1' })).toEqual({
        ok: false,
        reason: 'not_a_file',
      })
    })

    it('returns storage_not_found when the file storage row is gone', async () => {
      const deps = makeDeps({
        webdavPath: { resolveExistingWebDavPath: async () => target({ matter: file('m1') }) },
        storages: { get: async () => null },
      })
      expect(await resolveWebDavDownload(deps, { userId: 'u1', rawPath: '/dav/workspace/m1.txt' })).toEqual({
        ok: false,
        reason: 'storage_not_found',
      })
    })

    it('resolves matter + workspace + storage for a file', async () => {
      const m = file('m1')
      const deps = makeDeps({ webdavPath: { resolveExistingWebDavPath: async () => target({ matter: m }) } })
      const out = await resolveWebDavDownload(deps, { userId: 'u1', rawPath: '/dav/workspace/m1.txt' })
      expect(out).toEqual({ ok: true, matter: m, workspace, storage })
    })
  })

  describe('putWebDavFile', () => {
    const putParams = (overrides: Partial<Parameters<typeof putWebDavFile>[1]> = {}) => ({
      userId: 'u1',
      target: target(),
      fileName: 'new.txt',
      parent: '',
      contentType: 'text/plain',
      contentLength: 9 as number | null,
      body: new Uint8Array(9),
      createdBy: { type: 'api_key' as const, ref: 'key-1', issuer: null },
      ...overrides,
    })

    it('returns no_storage when no storage is available', async () => {
      const deps = makeDeps({ storages: { select: async () => null as unknown as StorageRecord } })
      expect(await putWebDavFile(deps, putParams())).toEqual({ ok: false, reason: 'no_storage' })
    })

    it('creates a new file matter and returns 201 [spec: webdav/put-create]', async () => {
      const create = vi.fn(async () => file('new'))
      const putObject = vi.fn(async (..._args: Parameters<S3Gateway['putObject']>) => 9)
      const deps = makeDeps({ matter: { create }, s3: { putObject } })
      const out = await putWebDavFile(deps, putParams())
      expect(out).toEqual({ ok: true, status: 201, matterId: 'new', storageId: 'st-1', bytes: 9 })
      const storageKey = putObject.mock.calls[0]?.[1]
      expect(storageKey).toMatch(/^u1\/\d{8}\/[A-Za-z0-9]{17}\.txt$/)
      expect(putObject).toHaveBeenCalledWith(storage, storageKey, expect.any(Uint8Array), 'text/plain', 9)
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'new.txt',
          size: 9,
          dirtype: DirType.FILE,
          status: 'active',
          object: storageKey,
          createdByActorType: 'api_key',
          createdByActorRef: 'key-1',
          createdByActorIssuer: null,
        }),
      )
    })

    it('overwrites an existing file in place and returns 204 [spec: webdav/put-update]', async () => {
      const applyUpload = vi.fn(async () => {})
      const deleteObject = vi.fn(async () => {})
      const existing = file('m1', { object: 'objects/m1.txt', size: 20 })
      const deps = makeDeps({ matter: { applyUpload }, s3: { deleteObject, putObject: async () => 5 } })
      const out = await putWebDavFile(deps, putParams({ target: target({ matter: existing }), contentLength: 5 }))
      expect(out).toEqual({ ok: true, status: 204, matterId: 'm1', storageId: 'st-1', bytes: 5 })
      // Same object key is reused (known length + existing object), so no delete.
      expect(applyUpload).toHaveBeenCalledWith(existing, {
        type: 'text/plain',
        size: 5,
        object: 'objects/m1.txt',
      })
      expect(deleteObject).not.toHaveBeenCalled()
    })

    it('rejects an unsafe user ID before overwriting an existing S3 object [spec: webdav/path-validation]', async () => {
      const putObject = vi.fn(async () => 5)
      const existing = file('m1', { object: 'legacy_/existing-file-.txt', size: 20 })
      const deps = makeDeps({ s3: { putObject } })

      await expect(
        putWebDavFile(
          deps,
          putParams({ target: target({ matter: existing }), contentLength: 5, userId: 'invalid:user' }),
        ),
      ).rejects.toThrow('Invalid user ID for object storage key')
      expect(putObject).not.toHaveBeenCalled()
      expect(existing.object).toBe('legacy_/existing-file-.txt')
    })

    it('reconciles usage when an overwrite shrinks the file', async () => {
      const reconcile = vi.fn(async () => {})
      const existing = file('m1', { object: 'objects/m1.txt', size: 20 })
      const deps = makeDeps({ storageUsage: { reconcile }, s3: { putObject: async () => 5 } })
      await putWebDavFile(deps, putParams({ target: target({ matter: existing }), contentLength: 5 }))
      expect(reconcile).toHaveBeenCalledWith(['st-1'])
    })

    it('persists the measured size after a streamed (no Content-Length) upload', async () => {
      const create = vi.fn(async () => file('new'))
      const deps = makeDeps({
        matter: { create },
        s3: { putObject: async () => 42 },
      })
      const out = await putWebDavFile(deps, putParams({ contentLength: null, body: new Uint8Array() }))
      expect(out).toEqual({ ok: true, status: 201, matterId: 'new', storageId: 'st-1', bytes: 42 })
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ size: 42 }))
    })

    it('rolls back the S3 write when persisting the matter fails [spec: webdav/put-rollback]', async () => {
      const deleteObject = vi.fn(async () => {})
      const deps = makeDeps({
        s3: { putObject: async () => 9, deleteObject },
        matter: {
          create: async () => {
            throw new Error('db down')
          },
        },
      })
      await expect(putWebDavFile(deps, putParams())).rejects.toThrow('db down')
      expect(deleteObject).toHaveBeenCalledWith(storage, expect.any(String))
    })
  })

  describe('createWebDavCollection', () => {
    it('creates a folder matter under the selected private storage [spec: webdav/mkcol]', async () => {
      const create = vi.fn(async () => folder('Projects'))
      const deps = makeDeps({ matter: { create } })
      await createWebDavCollection(deps, {
        userId: 'u1',
        name: 'Projects',
        parent: 'Docs',
        createdBy: { type: 'api_key', ref: 'key-1', issuer: null },
      })
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Projects',
          type: 'folder',
          dirtype: DirType.USER_FOLDER,
          parent: 'Docs',
          object: '',
          status: 'active',
          createdByActorType: 'api_key',
          createdByActorRef: 'key-1',
        }),
      )
    })
  })

  describe('deleteWebDavMatter', () => {
    it('clears dav state then trashes the matter', async () => {
      const order: string[] = []
      const deleteWebDavState = vi.fn(async () => {
        order.push('state')
      })
      const trash = vi.fn(async () => {
        order.push('trash')
        return file('m1', { trashedAt: Date.now() })
      })
      const deps = makeDeps({ webdavState: { deleteWebDavState }, matter: { trash } })
      await deleteWebDavMatter(deps, { resourcePath: 'gone.txt', matterId: 'm1' })
      expect(deleteWebDavState).toHaveBeenCalledWith('gone.txt')
      expect(trash).toHaveBeenCalledWith('m1')
      expect(order).toEqual(['state', 'trash'])
    })
  })

  describe('moveWebDavMatter', () => {
    it('renames/reparents the source and moves its dav state [spec: webdav/move-descendants]', async () => {
      const update = vi.fn(async () => file('m1'))
      const moveWebDavState = vi.fn(async () => {})
      const trash = vi.fn()
      const deps = makeDeps({ matter: { update, trash }, webdavState: { moveWebDavState } })
      await moveWebDavMatter(deps, {
        userId: 'u1',
        sourceMatterId: 'm1',
        sourceResourcePath: 'src.txt',
        targetName: 'dst.txt',
        targetParent: 'Docs',
        targetResourcePath: 'Docs/dst.txt',
        replacedMatterId: null,
      })
      expect(update).toHaveBeenCalledWith('m1', { name: 'dst.txt', parent: 'Docs' })
      expect(moveWebDavState).toHaveBeenCalledWith('src.txt', 'Docs/dst.txt')
      expect(trash).not.toHaveBeenCalled()
    })

    it('trashes an overwritten destination before moving [spec: webdav/move-overwrite]', async () => {
      const trash = vi.fn(async () => file('t1', { trashedAt: Date.now() }))
      const deleteWebDavState = vi.fn(async () => {})
      const deps = makeDeps({ matter: { trash }, webdavState: { deleteWebDavState } })
      await moveWebDavMatter(deps, {
        userId: 'u1',
        sourceMatterId: 'm1',
        sourceResourcePath: 'src.txt',
        targetName: 'dst.txt',
        targetParent: '',
        targetResourcePath: 'dst.txt',
        replacedMatterId: 't1',
      })
      expect(deleteWebDavState).toHaveBeenCalledWith('dst.txt')
      expect(trash).toHaveBeenCalledWith('t1')
    })
  })

  describe('copyWebDavFile', () => {
    const copyParams = (overrides: Partial<Parameters<typeof copyWebDavFile>[1]> = {}) => ({
      userId: 'u1',
      sourceMatter: file('src', { size: 12 }),
      sourceResourcePath: 'src.txt',
      targetName: 'dst.txt',
      targetParent: '',
      targetResourcePath: 'dst.txt',
      replacedMatterId: null,
      replacingTarget: false,
      createdBy: { type: 'api_key' as const, ref: 'key-1', issuer: null },
      ...overrides,
    })

    it('copies the object + matter + dead properties and returns 201', async () => {
      const copyObject = vi.fn(async (..._args: Parameters<S3Gateway['copyObject']>) => {})
      const copyDeadProperties = vi.fn(async () => {})
      const copy = vi.fn(async (s: Matter, parent: string, object: string) =>
        file('copy', { parent, object, name: s.name }),
      )
      const deps = makeDeps({ s3: { copyObject }, matter: { copy }, webdavState: { copyDeadProperties } })
      const sourceMatter = file('src', { size: 12, object: 'legacy_/webdav-source-.txt' })
      const out = await copyWebDavFile(deps, copyParams({ sourceMatter }))
      expect(out).toEqual({ ok: true, status: 201, location: 'dst.txt' })
      const destinationKey = copyObject.mock.calls[0]?.[3]
      expect(sourceMatter.object).toBe('legacy_/webdav-source-.txt')
      expect(destinationKey).toMatch(/^u1\/\d{8}\/[A-Za-z0-9]{17}\.txt$/)
      expect(copyObject).toHaveBeenCalledWith(storage, sourceMatter.object, storage, destinationKey)
      expect(copy).toHaveBeenCalledWith(expect.any(Object), '', destinationKey, {
        onConflict: 'fail',
        createdByActorType: 'api_key',
        createdByActorRef: 'key-1',
        createdByActorIssuer: null,
      })
      expect(copyDeadProperties).toHaveBeenCalledWith('src.txt', 'dst.txt')
    })

    it('returns 204 and trashes the destination when overwriting', async () => {
      const trash = vi.fn(async () => file('t1', { trashedAt: Date.now() }))
      const deps = makeDeps({ matter: { trash } })
      const out = await copyWebDavFile(deps, copyParams({ replacedMatterId: 't1', replacingTarget: true }))
      expect(out).toEqual({ ok: true, status: 204, location: 'dst.txt' })
      expect(trash).toHaveBeenCalledWith('t1')
    })

    it('returns storage_not_found when an object-backed source has no storage', async () => {
      const deps = makeDeps({ storages: { get: async () => null } })
      expect(await copyWebDavFile(deps, copyParams())).toEqual({ ok: false, reason: 'storage_not_found' })
    })

    it('rolls back the copied object when the matter copy fails', async () => {
      const deleteObject = vi.fn(async () => {})
      const deps = makeDeps({
        s3: { copyObject: async () => {}, deleteObject },
        matter: {
          copy: async () => {
            throw new NameConflictError('dst.txt', 'x')
          },
        },
      })
      await expect(copyWebDavFile(deps, copyParams())).rejects.toBeInstanceOf(NameConflictError)
      expect(deleteObject).toHaveBeenCalledWith(storage, expect.any(String))
    })

    it('copies a zero-object source (e.g. empty file) without touching S3', async () => {
      const copyObject = vi.fn(async () => {})
      const deps = makeDeps({ s3: { copyObject } })
      const out = await copyWebDavFile(deps, copyParams({ sourceMatter: file('src', { object: '', size: 0 }) }))
      expect(out.ok).toBe(true)
      expect(copyObject).not.toHaveBeenCalled()
    })
  })

  describe('copyWebDavCollection', () => {
    const tree = () => {
      const child = folder('child', { name: 'Nested', parent: 'Source' })
      const grandchild = file('gc', { name: 'note.txt', parent: 'Source/Nested', size: 12 })
      return { child, grandchild }
    }

    const collParams = (overrides: Partial<Parameters<typeof copyWebDavCollection>[1]> = {}) => ({
      userId: 'u1',
      sourceMatter: folder('src', { name: 'Source' }),
      sourceRoot: 'Source',
      targetName: 'Copied',
      targetParent: '',
      targetResourcePath: 'Copied',
      targetMatter: null,
      replacingTarget: false,
      depth: 'infinity' as const,
      createdBy: { type: 'api_key' as const, ref: 'key-1', issuer: null },
      ...overrides,
    })

    it('recursively copies the root + descendants, rewriting parents and dead properties [spec: webdav/copy-recursive]', async () => {
      const { child, grandchild } = tree()
      const copies: Array<{ name: string; parent: string; object: string }> = []
      const copy = vi.fn(async (s: Matter, parent: string, object: string) => {
        copies.push({ name: s.name, parent, object })
        return file('c', { name: s.name, parent, object })
      })
      const copyDeadProperties = vi.fn(async () => {})
      const deps = makeDeps({
        matter: { copy, listActiveDescendants: async () => [grandchild] },
        webdavPath: { listChildren: async () => [child] },
        webdavState: { copyDeadProperties },
      })
      const out = await copyWebDavCollection(deps, collParams())
      expect(out).toEqual({ ok: true, status: 201, location: 'Copied' })
      // Root first (renamed to the target name, matching the original), then
      // child under Copied, then grandchild under Copied/Nested.
      expect(copies).toEqual([
        { name: 'Copied', parent: '', object: '' },
        { name: 'Nested', parent: 'Copied', object: '' },
        {
          name: 'note.txt',
          parent: 'Copied/Nested',
          object: expect.stringMatching(/^u1\/\d{8}\/[A-Za-z0-9]{17}\.txt$/),
        },
      ])
      expect(copy).toHaveBeenCalledWith(expect.any(Object), '', '', {
        onConflict: 'fail',
        createdByActorType: 'api_key',
        createdByActorRef: 'key-1',
        createdByActorIssuer: null,
      })
    })

    it('copies only the root when depth=0', async () => {
      const copy = vi.fn(async (s: Matter, parent: string) => file('c', { name: s.name, parent }))
      const listChildren = vi.fn(async () => [tree().child])
      const deps = makeDeps({ matter: { copy }, webdavPath: { listChildren } })
      const out = await copyWebDavCollection(deps, collParams({ depth: '0' }))
      expect(out.ok).toBe(true)
      // depth=0 ignores children for the copy ordering.
      expect(copy).toHaveBeenCalledTimes(1)
    })

    it('returns storage_not_found when a descendant file has no storage', async () => {
      const { grandchild } = tree()
      const deps = makeDeps({
        matter: { listActiveDescendants: async () => [grandchild] },
        storages: { get: async () => null },
      })
      expect(await copyWebDavCollection(deps, collParams())).toEqual({ ok: false, reason: 'storage_not_found' })
    })

    it('trashes created rows and restores the overwritten destination when a copy fails [spec: webdav/copy-rollback]', async () => {
      const { grandchild } = tree()
      const trashByIds = vi.fn(async () => {})
      const restoreActiveByIds = vi.fn(async () => {})
      const targetMatter = folder('existing', { name: 'Copied' })
      let copyCount = 0
      const copy = vi.fn(async (s: Matter, parent: string) => {
        copyCount += 1
        if (copyCount === 2) throw new Error('copy failed')
        return file(`c${copyCount}`, { name: s.name, parent })
      })
      const deps = makeDeps({
        matter: { copy, trashByIds, restoreActiveByIds, listActiveDescendants: async () => [grandchild] },
        webdavPath: { listChildren: async () => [] },
      })
      await expect(copyWebDavCollection(deps, collParams({ targetMatter, replacingTarget: true }))).rejects.toThrow(
        'copy failed',
      )
      expect(trashByIds).toHaveBeenCalledWith(['c1'])
      expect(restoreActiveByIds).toHaveBeenCalledWith(expect.arrayContaining(['existing']))
    })
  })

  describe('createWebDavLock', () => {
    it('acquires a lock on an existing resource without creating anything [spec: webdav/lock-unlock]', async () => {
      const create = vi.fn()
      const putObject = vi.fn()
      const tryCreateLock = vi.fn(async () => lock)
      const deps = makeDeps({ matter: { create }, s3: { putObject }, webdavState: { tryCreateLock } })
      const out = await createWebDavLock(deps, {
        userId: 'u1',
        resourcePath: 'doc.txt',
        target: target({ matter: file('m1'), name: 'doc.txt' }),
        owner: 'tester',
        depth: '0',
        timeoutSeconds: 600,
        createdBy: { type: 'api_key', ref: 'key-1', issuer: null },
      })
      expect(out).toEqual({ lock, created: false })
      expect(create).not.toHaveBeenCalled()
      expect(putObject).not.toHaveBeenCalled()
      expect(tryCreateLock).toHaveBeenCalledWith({
        resourcePath: 'doc.txt',
        owner: 'tester',
        depth: '0',
        timeoutSeconds: 600,
      })
    })

    it('lazily creates an empty file when locking an unmapped URL (created=true) [spec: webdav/lock-preconditions]', async () => {
      const putObject = vi.fn(async (..._args: Parameters<S3Gateway['putObject']>) => 0)
      const create = vi.fn(async () => file('new', { size: 0, type: 'application/octet-stream' }))
      const deps = makeDeps({ s3: { putObject }, matter: { create } })
      const out = await createWebDavLock(deps, {
        userId: 'u1',
        resourcePath: 'new.txt',
        target: target({ matter: null, name: 'new.txt' }),
        owner: 'tester',
        depth: 'infinity',
        timeoutSeconds: 3600,
        createdBy: { type: 'api_key', ref: 'key-1', issuer: null },
      })
      expect(out).not.toBeNull()
      if (!out) throw new Error('Expected lock to be created')
      expect(out.created).toBe(true)
      const storageKey = putObject.mock.calls[0]?.[1]
      expect(storageKey).toMatch(/^u1\/\d{8}\/[A-Za-z0-9]{17}\.txt$/)
      expect(putObject).toHaveBeenCalledWith(storage, storageKey, expect.any(Uint8Array), 'application/octet-stream')
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'new.txt',
          size: 0,
          dirtype: DirType.FILE,
          status: 'active',
          object: storageKey,
          createdByActorType: 'api_key',
          createdByActorRef: 'key-1',
        }),
      )
    })
  })
})
