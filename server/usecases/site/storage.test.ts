import type { CreateStorageInput, ReplaceStorageInput } from '@shared/schemas'
import { describe, expect, it, vi } from 'vitest'
import type { StorageRecord, StorageRepo } from '../ports'
import {
  createStorage,
  deleteStorage,
  getStorage,
  listStorages,
  patchStorage,
  replaceStorage,
  type StorageDeps,
} from './storage'

const sampleStorage = { id: 'st-1', bucket: 'b' } as StorageRecord

const validInput: CreateStorageInput = {
  bucket: 'b',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  accessKey: 'k',
  secretKey: 's',
} as CreateStorageInput

const validReplacement: ReplaceStorageInput = {
  provider: '',
  bucket: 'new-b',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  accessKey: 'k',
  secretKey: 's',
  capacity: 0,
  forcePathStyle: true,
  enabled: true,
} as ReplaceStorageInput

function makeDeps(storages: Partial<StorageRepo> = {}) {
  const repo: StorageRepo = {
    list: async () => ({ items: [], total: 0 }),
    get: async () => null,
    create: async () => sampleStorage,
    count: async () => 0,
    replace: async () => null,
    patch: async () => null,
    delete: async () => 'ok',
    select: async () => sampleStorage,
    ...storages,
  }
  const deps: StorageDeps = {
    storages: repo,
  }
  return { deps }
}

describe('storage usecase', () => {
  it('listStorages forwards the repo result', async () => {
    const { deps } = makeDeps({ list: async () => ({ items: [sampleStorage], total: 1 }) })
    expect(await listStorages(deps)).toEqual({ items: [sampleStorage], total: 1 })
  })

  it('getStorage returns the record', async () => {
    const { deps } = makeDeps({ get: async () => sampleStorage })
    expect(await getStorage(deps, 'st-1')).toBe(sampleStorage)
  })

  it('getStorage returns null when missing', async () => {
    const { deps } = makeDeps({ get: async () => null })
    expect(await getStorage(deps, 'nope')).toBeNull()
  })

  describe('createStorage', () => {
    it('creates the storage', async () => {
      const create = vi.fn(async () => sampleStorage)
      const { deps } = makeDeps({ create })
      const out = await createStorage(deps, { input: validInput })
      expect(out).toEqual({ ok: true, storage: sampleStorage })
      expect(create).toHaveBeenCalledWith(validInput)
    })
  })

  describe('replaceStorage', () => {
    it('replaces the storage', async () => {
      const replace = vi.fn(async () => sampleStorage)
      const { deps } = makeDeps({ replace })
      const out = await replaceStorage(deps, { id: 'st-1', input: validReplacement })
      expect(out).toEqual({ ok: true, storage: sampleStorage })
      expect(replace).toHaveBeenCalledWith('st-1', validReplacement)
    })

    it('returns not_found for a missing storage', async () => {
      const { deps } = makeDeps({ replace: async () => null })
      const out = await replaceStorage(deps, { id: 'x', input: validReplacement })
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.error).toBeInstanceOf(Error)
        expect(out.error.httpStatus).toBe(404)
        expect(out.error.message).toBe('Storage not found')
      }
    })
  })

  describe('patchStorage', () => {
    it('patches only the requested fields', async () => {
      const patch = vi.fn(async () => sampleStorage)
      const { deps } = makeDeps({ patch })
      const out = await patchStorage(deps, { id: 'st-1', input: { enabled: false } })
      expect(out).toEqual({ ok: true, storage: sampleStorage })
      expect(patch).toHaveBeenCalledWith('st-1', { enabled: false })
    })
  })

  describe('deleteStorage', () => {
    it('deletes the storage', async () => {
      const del = vi.fn(async () => 'ok' as const)
      const { deps } = makeDeps({ get: async () => sampleStorage, delete: del })
      const out = await deleteStorage(deps, { id: 'st-1' })
      expect(out).toEqual({ ok: true })
    })

    it('returns not_found for a missing storage', async () => {
      const { deps } = makeDeps({ get: async () => null, delete: async () => 'not_found' })
      const out = await deleteStorage(deps, { id: 'x' })
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.error).toBeInstanceOf(Error)
        expect(out.error.httpStatus).toBe(404)
        expect(out.error.message).toBe('Storage not found')
      }
    })

    it('returns in_use when the storage is referenced', async () => {
      const { deps } = makeDeps({ get: async () => sampleStorage, delete: async () => 'in_use' })
      const out = await deleteStorage(deps, { id: 'st-1' })
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.error).toBeInstanceOf(Error)
        expect(out.error.httpStatus).toBe(409)
        expect(out.error.message).toBe('Storage is referenced by existing files')
      }
    })
  })
})
