import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Matter, S3Gateway, ShareRecord, ShareRepo, ShareResolution, StorageRecord, StorageRepo } from './ports'
import { AppError } from './ports'
import {
  directShareDownloadAuditTarget,
  type RedirectDeps,
  resolveDirectShareDownload as resolveDirectShareDownloadFromResolution,
  resolveDirectShareRedirectTarget,
} from './redirect'

// Asserts a usecase returned a failure AppError with the given HTTP status,
// wire reason, and message — the AIP-193 fields the http boundary renders.
function expectError(
  out: { ok: true } | { ok: false; error: AppError },
  httpStatus: number,
  reason: string | undefined,
  message: string,
) {
  expect(out.ok).toBe(false)
  const { error } = out as { ok: false; error: AppError }
  expect(error).toBeInstanceOf(AppError)
  expect(error.httpStatus).toBe(httpStatus)
  expect(error.meta.reason).toBe(reason)
  expect(error.message).toBe(message)
}

const PRESIGNED_DOWNLOAD = 'https://presigned-download.example.com/file'

const sampleStorage = { id: 'st-1', bucket: 'b' } as StorageRecord

const sampleMatter = {
  id: 'm-1',
  name: 'file.bin',
  object: 'some/key.bin',
  storageId: 'st-1',
  size: 1024,
} as Matter

const sampleShare = {
  id: 's-1',
  token: 'sDirectTok01',
  kind: 'direct',
  matterId: 'm-1',
  expiresAt: null,
  downloadLimit: null,
} as ShareRecord

function makeShareRepo(over: Partial<ShareRepo> = {}): ShareRepo {
  return {
    resolveByToken: async (): Promise<ShareResolution> => ({
      status: 'ok',
      share: sampleShare,
      matter: sampleMatter,
      recipients: [],
    }),
    hasDownloadsAvailable: async () => true,
    incrementDownloadsAtomic: async () => ({ ok: true, downloads: 1 }),
    decrementDownloads: async () => {},
    ...over,
  } as ShareRepo
}

function makeDeps(over: { share?: Partial<ShareRepo>; storages?: Partial<StorageRepo>; s3?: Partial<S3Gateway> } = {}) {
  const decrementDownloads = vi.fn(async () => {})
  const presignDownload = vi.fn(async () => PRESIGNED_DOWNLOAD)

  const deps = {
    share: makeShareRepo({ decrementDownloads, ...over.share }),
    storages: { get: async () => sampleStorage, ...over.storages } as StorageRepo,
    s3: { presignDownload, ...over.s3 } as S3Gateway,
  } as RedirectDeps

  return { deps, decrementDownloads, presignDownload }
}

async function resolveDirectShareDownload(deps: RedirectDeps, params: { token: string; now?: Date }) {
  const { token: _token, ...rest } = params
  return resolveDirectShareDownloadFromResolution(deps, {
    ...rest,
    resolved: await deps.share.resolveByToken(params.token),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('redirect download audit targets', () => {
  it('derives the direct-share audit target from the same resolved record used for download', () => {
    const resolved: ShareResolution = { status: 'ok', share: sampleShare, matter: sampleMatter, recipients: [] }
    expect(directShareDownloadAuditTarget(resolved)).toMatchObject({
      targetType: 'share',
      targetId: sampleShare.id,
      metadata: { shareId: sampleShare.id, matterId: sampleMatter.id },
    })
  })

  it('does not create a direct-share audit target for landing shares', () => {
    const resolved: ShareResolution = {
      status: 'ok',
      share: { ...sampleShare, kind: 'landing' },
      matter: sampleMatter,
      recipients: [],
    }
    expect(directShareDownloadAuditTarget(resolved)).toBeNull()
  })

  it('resolves the share namespace once and returns the audit target with that record', async () => {
    const share = makeShareRepo({ resolveByToken: vi.fn(makeShareRepo().resolveByToken) })

    const shareTarget = await resolveDirectShareRedirectTarget({ share }, sampleShare.token)

    expect(share.resolveByToken).toHaveBeenCalledOnce()
    expect(shareTarget.auditTarget?.targetId).toBe(sampleShare.id)
  })
})

// ─── resolveDirectShareDownload ──────────────────────────────────────────────

describe('resolveDirectShareDownload', () => {
  it('presigns the download and returns the URL on the happy path', async () => {
    const { deps, presignDownload } = makeDeps()
    const out = await resolveDirectShareDownload(deps, { token: 'sDirectTok01' })
    expect(out).toMatchObject({ ok: true, url: PRESIGNED_DOWNLOAD })
    expect(presignDownload).toHaveBeenCalledWith(sampleStorage, 'some/key.bin', 'file.bin', expect.any(Number))
  })

  it('returns matter_trashed when the share resolves to a trashed matter', async () => {
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => ({
          status: 'matter_trashed',
          share: sampleShare,
          matter: sampleMatter,
          recipients: [],
        }),
      },
    })
    const out = await resolveDirectShareDownload(deps, { token: 'sDirectTok01' })
    expectError(out, 410, undefined, 'File no longer available')
  })

  it('returns not_found when the token does not resolve', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => ({ status: 'not_found' }) } })
    const out = await resolveDirectShareDownload(deps, { token: 'sDirectTok01' })
    expectError(out, 404, undefined, 'Share not found or revoked')
  })

  it('returns not_found when the share is revoked', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => ({ status: 'revoked' }) } })
    const out = await resolveDirectShareDownload(deps, { token: 'sDirectTok01' })
    expectError(out, 404, undefined, 'Share not found or revoked')
  })

  it('returns not_found when the share kind is not direct (e.g. landing)', async () => {
    const landing = { ...sampleShare, kind: 'landing' } as ShareRecord
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => ({ status: 'ok', share: landing, matter: sampleMatter, recipients: [] }),
      },
    })
    const out = await resolveDirectShareDownload(deps, { token: 'sDirectTok01' })
    expectError(out, 404, undefined, 'Share not found or revoked')
  })

  it('returns expired when expiresAt is in the past', async () => {
    const expired = { ...sampleShare, expiresAt: new Date('2000-01-01') } as ShareRecord
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => ({ status: 'ok', share: expired, matter: sampleMatter, recipients: [] }),
      },
    })
    const out = await resolveDirectShareDownload(deps, {
      token: 'sDirectTok01',
      now: new Date('2030-01-01'),
    })
    expectError(out, 410, undefined, 'Share has expired')
  })

  it('returns limit_exceeded when no downloads remain', async () => {
    const { deps, presignDownload } = makeDeps({ share: { hasDownloadsAvailable: async () => false } })
    const out = await resolveDirectShareDownload(deps, { token: 'sDirectTok01' })
    expectError(out, 410, undefined, 'Download limit exceeded')
    expect(presignDownload).not.toHaveBeenCalled()
  })

  it('returns limit_exceeded when the atomic increment loses the race', async () => {
    const { deps, presignDownload } = makeDeps({
      share: { incrementDownloadsAtomic: async () => ({ ok: false, downloads: 0 }) },
    })
    const out = await resolveDirectShareDownload(deps, { token: 'sDirectTok01' })
    expectError(out, 410, undefined, 'Download limit exceeded')
    expect(presignDownload).not.toHaveBeenCalled()
  })

  it('returns storage_not_found when the storage is missing', async () => {
    const { deps } = makeDeps({ storages: { get: async () => null } })
    const out = await resolveDirectShareDownload(deps, { token: 'sDirectTok01' })
    expectError(out, 404, undefined, 'Storage not found')
  })

  it('decrements the download when presign fails, then rethrows', async () => {
    const presignDownload = vi.fn(async () => {
      throw new Error('sign failed')
    })
    const { deps, decrementDownloads } = makeDeps({ s3: { presignDownload } })
    await expect(resolveDirectShareDownload(deps, { token: 'sDirectTok01' })).rejects.toThrow('sign failed')
    expect(decrementDownloads).toHaveBeenCalledWith('s-1')
  })
})
