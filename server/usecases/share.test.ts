import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeChildRef } from '../http/share-utils'
import { hashPassword } from '../lib/password'
import { saveShareToDrive } from './object'
import {
  AppError,
  CreateShareError,
  type Matter,
  type MatterListResult,
  type MatterRepo,
  type S3Gateway,
  type ShareListItem,
  type ShareRecipientRecord,
  type ShareRecord,
  type ShareRepo,
  type ShareResolution,
  type StorageRecord,
  type StorageRepo,
} from './ports'
import {
  createShare,
  downloadShareObject,
  listShareObjects,
  listShares,
  readShareReadme,
  revokeShare,
  type ShareDeps,
  saveShare,
  setSharePrivacy,
  verifySharePassword,
  viewShare,
} from './share'

// The recipient fan-out and the copy engine are covered by
// share-notification/save-to-drive tests. Here we replace the copy engine with
// a mock so each share case feeds a chosen outcome and we can assert the share
// routes' gates, ordering, DTO shaping, and presign-rollback in isolation.
// Everything else (types, pure helpers) stays real.
vi.mock('./object', () => ({ saveShareToDrive: vi.fn() }))

const PRESIGNED_URL = 'https://presigned.example.com/file'

// Asserts a usecase returned a failure AppError carrying the given HTTP status,
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

const saveToDrive = vi.mocked(saveShareToDrive)

const sampleStorage = { id: 'st-1', bucket: 'b' } as StorageRecord

const fileMatter = {
  id: 'm-1',
  name: 'file.bin',
  type: 'application/octet-stream',
  size: 1024,
  dirtype: 0, // DirType.FILE
  parent: '',
  object: 'some/key.bin',
  storageId: 'st-1',
} as Matter

const folderMatter = {
  id: 'fld-1',
  name: 'docs',
  type: 'folder',
  size: 0,
  dirtype: 1, // not FILE
  parent: 'root',
  object: '',
  storageId: 'st-1',
} as Matter

const childMatter = { ...fileMatter, id: 'm-child', name: 'child.txt' } as Matter

const landingShare = {
  id: 's-1',
  token: 'sk_token1',
  kind: 'landing',
  matterId: 'm-1',
  creatorId: 'creator-1',
  passwordHash: null,
  expiresAt: null,
  downloadLimit: null,
  views: 3,
  downloads: 2,
  status: 'active',
  createdAt: new Date('2024-01-01T00:00:00Z'),
} as ShareRecord

const okResolution = (
  over: { share?: ShareRecord; matter?: Matter; recipients?: ShareRecipientRecord[] } = {},
): ShareResolution => ({ status: 'ok', share: landingShare, matter: fileMatter, recipients: [], ...over })

const trashedResolution = (
  over: { share?: ShareRecord; matter?: Matter; recipients?: ShareRecipientRecord[] } = {},
): ShareResolution => ({ status: 'matter_trashed', share: landingShare, matter: fileMatter, recipients: [], ...over })

function makeShareRepo(over: Partial<ShareRepo> = {}): ShareRepo {
  return {
    resolveByToken: async () => okResolution(),
    incrementViews: async () => {},
    hasDownloadsAvailable: async () => true,
    incrementDownloadsAtomic: async () => ({ ok: true, downloads: 3 }),
    decrementDownloads: async () => {},
    revokeByToken: async () => true,
    setPrivacy: async () => true,
    listForApi: async () => ({ items: [], nextBoundary: null }),
    listReceivedForApi: async () => ({ items: [], nextBoundary: null }),
    listDirectActiveChildren: async () => [],
    getCreatorIdentity: async () => ({ name: 'Creator Name' }),
    getUserEmail: async () => 'creator@example.com',
    getMatterName: async () => 'file.bin',
    findShareChildMatter: async () => childMatter,
    create: async () => landingShare,
    listRecipientUserIds: async () => [],
    revokeByMatter: async () => {},
    ...over,
  } as ShareRepo
}

const emptyMatterList: MatterListResult = { items: [], nextBoundary: null }

function makeDeps(
  over: {
    share?: Partial<ShareRepo>
    matter?: Partial<MatterRepo>
    storages?: Partial<StorageRepo>
    s3?: Partial<S3Gateway>
  } = {},
) {
  const incrementViews = vi.fn(async () => {})
  const decrementDownloads = vi.fn(async () => {})
  const presignDownload = vi.fn(async () => PRESIGNED_URL)
  // dispatchShareCreated now lives in this module, so its call cannot be mocked
  // at the module boundary; instead its collaborator ports are spies and the
  // createShare tests assert the observable fan-out (in-app notifications).
  const createNotification = vi.fn(async () => ({}) as never)

  const deps = {
    share: makeShareRepo({ incrementViews, decrementDownloads, ...over.share }),
    matter: { list: async () => emptyMatterList, ...over.matter } as MatterRepo,
    storages: { get: async () => sampleStorage, ...over.storages } as StorageRepo,
    s3: { presignDownload, ...over.s3 } as S3Gateway,
    notifications: { create: createNotification } as unknown as ShareDeps['notifications'],
    storageUsage: {} as ShareDeps['storageUsage'],
  } as ShareDeps

  return {
    deps,
    incrementViews,
    decrementDownloads,
    presignDownload,
    createNotification,
  }
}

// dispatchShareCreated is launched fire-and-forget (.catch) by createShare;
// flush pending microtasks so its fan-out has run before asserting.
const flushDispatch = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  vi.clearAllMocks()
  saveToDrive.mockResolvedValue({ saved: [], skipped: [] })
})

// ─── viewShare ───────────────────────────────────────────────────────────────

describe('viewShare', () => {
  it('returns matter_trashed when the matter is trashed', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => trashedResolution() } })
    expectError(
      await viewShare(deps, { token: 't', viewerId: null, viewCookie: undefined, accessCookie: undefined }),
      410,
      undefined,
      'File no longer available',
    )
  })

  it('returns not_found for revoked/missing shares', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => ({ status: 'revoked' }) } })
    expectError(
      await viewShare(deps, { token: 't', viewerId: null, viewCookie: undefined, accessCookie: undefined }),
      404,
      undefined,
      'Share not found or revoked',
    )
  })

  it('hides a direct share from a non-creator (not_found)', async () => {
    const direct = { ...landingShare, kind: 'direct' } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: direct }) } })
    const out = await viewShare(deps, {
      token: 't',
      viewerId: 'someone',
      viewCookie: undefined,
      accessCookie: undefined,
    })
    expectError(out, 404, undefined, 'Share not found or revoked')
  })

  it('returns the viewer DTO and signals the view cookie for an anonymous viewer', async () => {
    const { deps, incrementViews } = makeDeps()
    const out = await viewShare(deps, {
      token: 'sk_token1',
      viewerId: null,
      viewCookie: undefined,
      accessCookie: undefined,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected ok')
    expect(out.setViewCookie).toBe(true)
    expect(incrementViews).toHaveBeenCalledWith('s-1')
    expect(out.dto).toMatchObject({
      token: 'sk_token1',
      kind: 'landing',
      matter: { name: 'file.bin', isFolder: false },
      creatorName: 'Creator Name',
      requiresPassword: false,
      expired: false,
      exhausted: false,
      accessibleByUser: false,
      rootRef: encodeChildRef('sk_token1', 'm-1'),
    })
    expect('recipients' in out.dto).toBe(false)
  })

  it('does not increment views (no cookie) when already seen', async () => {
    const { deps, incrementViews } = makeDeps()
    const out = await viewShare(deps, {
      token: 'sk_token1',
      viewerId: null,
      viewCookie: 'seen',
      accessCookie: undefined,
    })
    if (!out.ok) throw new Error('expected ok')
    expect(out.setViewCookie).toBe(false)
    expect(incrementViews).not.toHaveBeenCalled()
  })

  it('returns the richer creator DTO and never bumps views for the creator', async () => {
    const { deps, incrementViews } = makeDeps()
    const out = await viewShare(deps, {
      token: 'sk_token1',
      viewerId: 'creator-1',
      viewCookie: undefined,
      accessCookie: undefined,
    })
    if (!out.ok) throw new Error('expected ok')
    expect(out.setViewCookie).toBe(false)
    expect(incrementViews).not.toHaveBeenCalled()
    expect(out.dto).toMatchObject({
      id: 's-1',
      matterId: 'm-1',
      creatorId: 'creator-1',
      recipients: [],
    })
  })

  it('requiresPassword=true for a non-recipient viewer without the access cookie', async () => {
    const pw = { ...landingShare, passwordHash: 'hash' } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: pw }) } })
    const out = await viewShare(deps, {
      token: 'sk_token1',
      viewerId: 'x',
      viewCookie: 'seen',
      accessCookie: undefined,
    })
    if (!out.ok) throw new Error('expected ok')
    expect(out.dto.requiresPassword).toBe(true)
  })

  it('requiresPassword=false once the access cookie is ok', async () => {
    const pw = { ...landingShare, passwordHash: 'hash' } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: pw }) } })
    const out = await viewShare(deps, { token: 'sk_token1', viewerId: null, viewCookie: 'seen', accessCookie: 'ok' })
    if (!out.ok) throw new Error('expected ok')
    expect(out.dto.requiresPassword).toBe(false)
  })

  it('marks expired and exhausted from share state', async () => {
    const used = { ...landingShare, expiresAt: new Date('2000-01-01'), downloadLimit: 2, downloads: 2 } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: used }) } })
    const out = await viewShare(deps, {
      token: 'sk_token1',
      viewerId: null,
      viewCookie: 'seen',
      accessCookie: undefined,
      now: new Date('2030-01-01'),
    })
    if (!out.ok) throw new Error('expected ok')
    expect(out.dto.expired).toBe(true)
    expect(out.dto.exhausted).toBe(true)
  })

  it('reports a folder matter as isFolder', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ matter: folderMatter }) } })
    const out = await viewShare(deps, {
      token: 'sk_token1',
      viewerId: null,
      viewCookie: 'seen',
      accessCookie: undefined,
    })
    if (!out.ok) throw new Error('expected ok')
    expect(out.dto.matter.isFolder).toBe(true)
  })
})

// ─── verifySharePassword ─────────────────────────────────────────────────────

describe('verifySharePassword', () => {
  it('returns not_found when the token does not resolve', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => ({ status: 'not_found' }) } })
    expectError(
      await verifySharePassword(deps, { token: 't', password: 'x' }),
      404,
      undefined,
      'Share not found or revoked',
    )
  })

  it('returns not_found for a non-landing share', async () => {
    const direct = { ...landingShare, kind: 'direct', passwordHash: hashPassword('pw') } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: direct }) } })
    expectError(
      await verifySharePassword(deps, { token: 't', password: 'pw' }),
      404,
      undefined,
      'Share not found or revoked',
    )
  })

  it('returns invalid_password when the share has no password', async () => {
    const { deps } = makeDeps()
    expectError(await verifySharePassword(deps, { token: 't', password: 'pw' }), 403, undefined, 'Invalid password')
  })

  it('returns invalid_password on a wrong password', async () => {
    const pw = { ...landingShare, passwordHash: hashPassword('correct') } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: pw }) } })
    expectError(await verifySharePassword(deps, { token: 't', password: 'wrong' }), 403, undefined, 'Invalid password')
  })

  it('caps the cookie expiry at one day from now when no share expiry', async () => {
    const pw = { ...landingShare, passwordHash: hashPassword('correct'), expiresAt: null } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: pw }) } })
    const now = new Date('2025-01-01T00:00:00Z')
    const out = await verifySharePassword(deps, { token: 't', password: 'correct', now })
    if (!out.ok) throw new Error('expected ok')
    expect(out.setAccessCookieExpiry).toEqual(new Date('2025-01-02T00:00:00Z'))
  })

  it('clamps the cookie expiry to the share expiry when it is sooner than a day', async () => {
    const soon = new Date('2025-01-01T06:00:00Z')
    const pw = { ...landingShare, passwordHash: hashPassword('correct'), expiresAt: soon } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: pw }) } })
    const out = await verifySharePassword(deps, {
      token: 't',
      password: 'correct',
      now: new Date('2025-01-01T00:00:00Z'),
    })
    if (!out.ok) throw new Error('expected ok')
    expect(out.setAccessCookieExpiry).toEqual(soon)
  })
})

// ─── listShareObjects ────────────────────────────────────────────────────────

describe('listShareObjects', () => {
  const baseParams = {
    token: 'sk_token1',
    viewerId: null,
    accessCookie: 'ok',
    relativePath: '',
    pageSize: 50,
  }

  it('returns matter_trashed / not_found from resolution', async () => {
    const trashed = makeDeps({ share: { resolveByToken: async () => trashedResolution() } })
    expectError(await listShareObjects(trashed.deps, baseParams), 410, undefined, 'File no longer available')

    const revoked = makeDeps({ share: { resolveByToken: async () => ({ status: 'revoked' }) } })
    expectError(await listShareObjects(revoked.deps, baseParams), 404, undefined, 'Share not found or revoked')
  })

  it('returns not_found for a non-landing share', async () => {
    const direct = { ...landingShare, kind: 'direct' } as ShareRecord
    const { deps } = makeDeps({
      share: { resolveByToken: async () => okResolution({ share: direct, matter: folderMatter }) },
    })
    expectError(await listShareObjects(deps, baseParams), 404, undefined, 'Share not found or revoked')
  })

  it('returns not_a_folder for a file share', async () => {
    const { deps } = makeDeps() // default matter is a file
    expectError(await listShareObjects(deps, baseParams), 400, undefined, 'Not a folder share')
  })

  it('returns password_required when the gate blocks', async () => {
    const pw = { ...landingShare, passwordHash: 'hash' } as ShareRecord
    const { deps } = makeDeps({
      share: { resolveByToken: async () => okResolution({ share: pw, matter: folderMatter }) },
    })
    expectError(
      await listShareObjects(deps, { ...baseParams, accessCookie: undefined }),
      401,
      undefined,
      'Password required',
    )
  })

  it('returns expired before checking the path', async () => {
    const expired = { ...landingShare, expiresAt: new Date('2000-01-01') } as ShareRecord
    const { deps } = makeDeps({
      share: { resolveByToken: async () => okResolution({ share: expired, matter: folderMatter }) },
    })
    expectError(
      await listShareObjects(deps, { ...baseParams, relativePath: '../etc', now: new Date('2030-01-01') }),
      410,
      undefined,
      'Share has expired',
    )
  })

  it('returns invalid_path for a traversal attempt', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ matter: folderMatter }) } })
    expectError(await listShareObjects(deps, { ...baseParams, relativePath: 'a/../b' }), 400, undefined, 'Invalid path')
  })

  it('lists children, maps refs, and builds the breadcrumb at the folder root', async () => {
    const list = vi.fn(async () => ({
      items: [
        { ...folderMatter, hasChildren: false },
        { ...childMatter, hasChildren: false },
      ],
      nextBoundary: null,
    }))
    const { deps } = makeDeps({
      share: { resolveByToken: async () => okResolution({ matter: folderMatter }) },
      matter: { list },
    })
    const out = await listShareObjects(deps, baseParams)
    if (!out.ok) throw new Error('expected ok')
    // folderMatter.parent='root', name='docs' → queryParent='root/docs'
    expect(list).toHaveBeenCalledWith({ parent: 'root/docs', pageSize: 50, after: undefined })
    expect(out.result.items).toEqual([
      { ref: encodeChildRef('sk_token1', 'fld-1'), name: 'docs', type: 'folder', size: 0, isFolder: true },
      {
        ref: encodeChildRef('sk_token1', 'm-child'),
        name: 'child.txt',
        type: fileMatter.type,
        size: 1024,
        isFolder: false,
      },
    ])
    expect(out.result.breadcrumb).toEqual([{ name: 'docs', path: '' }])
  })

  it('descends into a subfolder path and reflects it in the breadcrumb', async () => {
    const list = vi.fn(async () => emptyMatterList)
    const { deps } = makeDeps({
      share: { resolveByToken: async () => okResolution({ matter: folderMatter }) },
      matter: { list },
    })
    const out = await listShareObjects(deps, { ...baseParams, relativePath: 'a/b' })
    if (!out.ok) throw new Error('expected ok')
    expect(list).toHaveBeenCalledWith({ parent: 'root/docs/a/b', pageSize: 50, after: undefined })
    expect(out.result.breadcrumb).toEqual([
      { name: 'docs', path: '' },
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' },
    ])
  })
})

// ─── readShareReadme ────────────────────────────────────────────────────────

describe('readShareReadme', () => {
  const baseParams = { token: 'sk_token1', viewerId: null, accessCookie: 'ok' }
  const readme = {
    ...fileMatter,
    id: 'readme-1',
    name: 'README.md',
    type: 'text/markdown',
    size: 24,
    parent: 'root/docs',
    object: 'root/docs/README.md',
  } as Matter

  it('reads the root README.md as UTF-8 without consuming a download', async () => {
    const listDirectActiveChildren = vi.fn(async () => [readme])
    const getObjectBytes = vi.fn(async () => new TextEncoder().encode('# Folder guide'))
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => okResolution({ matter: folderMatter }),
        listDirectActiveChildren,
      },
      s3: { getObjectBytes },
    })

    const out = await readShareReadme(deps, baseParams)

    expect(out).toEqual({ ok: true, content: '# Folder guide' })
    expect(listDirectActiveChildren).toHaveBeenCalledWith('root/docs')
    expect(getObjectBytes).toHaveBeenCalledWith(sampleStorage, 'root/docs/README.md')
  })

  it('returns not found when the folder has no root README.md', async () => {
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => okResolution({ matter: folderMatter }),
        listDirectActiveChildren: async () => [childMatter],
      },
    })

    expectError(await readShareReadme(deps, baseParams), 404, undefined, 'README.md not found')
  })

  it('enforces the share password gate', async () => {
    const protectedShare = { ...landingShare, passwordHash: 'hash' } as ShareRecord
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => okResolution({ share: protectedShare, matter: folderMatter }),
      },
    })

    expectError(
      await readShareReadme(deps, { ...baseParams, accessCookie: undefined }),
      401,
      undefined,
      'Password required',
    )
  })

  it('rejects README access for file shares', async () => {
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => okResolution({ matter: fileMatter }),
      },
    })

    expectError(await readShareReadme(deps, baseParams), 404, undefined, 'README.md not found')
  })

  it('rejects README files larger than one MiB', async () => {
    const oversizedReadme = { ...readme, size: 1024 * 1024 + 1 }
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => okResolution({ matter: folderMatter }),
        listDirectActiveChildren: async () => [oversizedReadme],
      },
    })

    expectError(await readShareReadme(deps, baseParams), 413, undefined, 'README.md is too large')
  })

  it('rejects README files that are not valid UTF-8', async () => {
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => okResolution({ matter: folderMatter }),
        listDirectActiveChildren: async () => [readme],
      },
      s3: {
        getObjectBytes: async () => new Uint8Array([0xff]),
      },
    })

    expectError(await readShareReadme(deps, baseParams), 400, undefined, 'README.md must be UTF-8 text')
  })
})

// ─── downloadShareObject ─────────────────────────────────────────────────────

describe('downloadShareObject', () => {
  const baseParams = {
    token: 'sk_token1',
    matterId: 'm-1',
    viewerId: null as string | null,
    accessCookie: 'ok' as string | undefined,
  }

  it('presigns and returns the URL on the happy path (root file)', async () => {
    const { deps, presignDownload } = makeDeps()
    const out = await downloadShareObject(deps, baseParams)
    expect(out).toMatchObject({
      ok: true,
      url: PRESIGNED_URL,
      receipt: { shareId: 's-1', matterId: 'm-1', bytes: 1024 },
    })
    expect(presignDownload).toHaveBeenCalledWith(sampleStorage, 'some/key.bin', 'file.bin', expect.any(Number))
  })

  it('returns matter_trashed / not_found from resolution', async () => {
    const trashed = makeDeps({ share: { resolveByToken: async () => trashedResolution() } })
    expectError(await downloadShareObject(trashed.deps, baseParams), 410, undefined, 'File no longer available')
    const revoked = makeDeps({ share: { resolveByToken: async () => ({ status: 'revoked' }) } })
    expectError(await downloadShareObject(revoked.deps, baseParams), 404, undefined, 'File not found or not accessible')
  })

  it('returns not_found for a non-landing share', async () => {
    const direct = { ...landingShare, kind: 'direct' } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: direct }) } })
    expectError(await downloadShareObject(deps, baseParams), 404, undefined, 'File not found or not accessible')
  })

  it('returns invalid_ref when the decoded matterId is null', async () => {
    const { deps } = makeDeps()
    expectError(await downloadShareObject(deps, { ...baseParams, matterId: null }), 400, undefined, 'Invalid reference')
  })

  it('returns password_required when the gate blocks', async () => {
    const pw = { ...landingShare, passwordHash: 'hash' } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: pw }) } })
    expectError(
      await downloadShareObject(deps, { ...baseParams, accessCookie: undefined }),
      401,
      undefined,
      'Password required',
    )
  })

  it('returns expired when past the share expiry', async () => {
    const expired = { ...landingShare, expiresAt: new Date('2000-01-01') } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: expired }) } })
    expectError(await downloadShareObject(deps, baseParams), 410, undefined, 'Share has expired')
  })

  it('resolves a descendant ref via findShareChildMatter', async () => {
    const findShareChildMatter = vi.fn(async () => childMatter)
    const { deps, presignDownload } = makeDeps({
      share: { resolveByToken: async () => okResolution({ matter: folderMatter }), findShareChildMatter },
    })
    const out = await downloadShareObject(deps, { ...baseParams, matterId: 'm-child' })
    expect(out).toMatchObject({ ok: true, url: PRESIGNED_URL, receipt: { matterId: 'm-child' } })
    expect(findShareChildMatter).toHaveBeenCalledWith(folderMatter, 'm-child')
    expect(presignDownload).toHaveBeenCalledWith(sampleStorage, childMatter.object, 'child.txt', expect.any(Number))
  })

  it('returns not_found when a descendant ref targets a file share root', async () => {
    const { deps } = makeDeps() // root is a file
    expectError(
      await downloadShareObject(deps, { ...baseParams, matterId: 'other' }),
      404,
      undefined,
      'File not found or not accessible',
    )
  })

  it('returns not_found when the descendant child is missing', async () => {
    const { deps } = makeDeps({
      share: {
        resolveByToken: async () => okResolution({ matter: folderMatter }),
        findShareChildMatter: async () => null,
      },
    })
    expectError(
      await downloadShareObject(deps, { ...baseParams, matterId: 'm-child' }),
      404,
      undefined,
      'File not found or not accessible',
    )
  })

  it('returns folder when the root itself is a folder requested directly', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ matter: folderMatter }) } })
    expectError(
      await downloadShareObject(deps, { ...baseParams, matterId: 'fld-1' }),
      400,
      undefined,
      'Cannot download a folder directly',
    )
  })

  it('returns limit_exceeded when no downloads remain', async () => {
    const { deps, presignDownload } = makeDeps({ share: { hasDownloadsAvailable: async () => false } })
    expectError(await downloadShareObject(deps, baseParams), 410, undefined, 'Download limit exceeded')
    expect(presignDownload).not.toHaveBeenCalled()
  })

  it('returns limit_exceeded when the atomic increment loses the race', async () => {
    const { deps, presignDownload } = makeDeps({
      share: { incrementDownloadsAtomic: async () => ({ ok: false, downloads: 0 }) },
    })
    expectError(await downloadShareObject(deps, baseParams), 410, undefined, 'Download limit exceeded')
    expect(presignDownload).not.toHaveBeenCalled()
  })

  it('returns storage_not_found when the storage is missing', async () => {
    const { deps } = makeDeps({ storages: { get: async () => null } })
    expectError(await downloadShareObject(deps, baseParams), 404, undefined, 'Storage not found')
  })

  it('decrements the download when presign fails, then rethrows', async () => {
    const presignDownload = vi.fn(async () => {
      throw new Error('sign failed')
    })
    const { deps, decrementDownloads } = makeDeps({ s3: { presignDownload } })
    await expect(downloadShareObject(deps, baseParams)).rejects.toThrow('sign failed')
    expect(decrementDownloads).toHaveBeenCalledWith('s-1')
  })
})

// ─── listShares ──────────────────────────────────────────────────────────────

describe('listShares', () => {
  const sentItem = { id: 's-1', token: 'sk_token1' } as ShareListItem

  it('lists the sent box via listForApi with status', async () => {
    const nextBoundary = { createdAt: new Date('2025-01-01'), id: 's-1' }
    const listForApi = vi.fn(async () => ({ items: [sentItem], nextBoundary }))
    const { deps } = makeDeps({ share: { listForApi } })
    const after = { createdAt: new Date('2025-02-01'), id: 's-2' }
    const out = await listShares(deps, {
      userId: 'u1',
      box: 'sent',
      pageSize: 10,
      status: 'active',
      after,
    })
    expect(listForApi).toHaveBeenCalledWith('u1', { pageSize: 10, status: 'active', after })
    expect(out).toEqual({ items: [sentItem], nextBoundary })
  })

  it('defaults to the sent box when box is undefined', async () => {
    const listForApi = vi.fn(async () => ({ items: [], nextBoundary: null }))
    const listReceivedForApi = vi.fn(async () => ({ items: [], nextBoundary: null }))
    const { deps } = makeDeps({ share: { listForApi, listReceivedForApi } })
    await listShares(deps, { userId: 'u1', box: undefined, pageSize: 20 })
    expect(listForApi).toHaveBeenCalled()
    expect(listReceivedForApi).not.toHaveBeenCalled()
  })

  it('lists the received box via listReceivedForApi, threading the user email', async () => {
    const getUserEmail = vi.fn(async () => 'me@example.com')
    const listReceivedForApi = vi.fn(async () => ({ items: [sentItem], nextBoundary: null }))
    const { deps } = makeDeps({ share: { getUserEmail, listReceivedForApi } })
    const out = await listShares(deps, { userId: 'u1', box: 'received', pageSize: 20 })
    expect(getUserEmail).toHaveBeenCalledWith('u1')
    expect(listReceivedForApi).toHaveBeenCalledWith('u1', 'me@example.com', {
      pageSize: 20,
      after: undefined,
    })
    expect(out).toEqual({ items: [sentItem], nextBoundary: null })
  })
})

// ─── createShare ─────────────────────────────────────────────────────────────

describe('createShare', () => {
  const baseInput = { matterId: 'm-1', kind: 'landing' as const }

  it('creates the share and returns the wire DTO', async () => {
    const create = vi.fn(async () => landingShare)
    const { deps } = makeDeps({ share: { create, getMatterName: async () => 'file.bin' } })
    const out = await createShare(deps, {
      userId: 'creator-1',
      input: { ...baseInput, password: 'pw', expiresAt: '2030-01-01T00:00:00Z', downloadLimit: 5 },
    })
    expect(out).toEqual({
      ok: true,
      share: { token: 'sk_token1', kind: 'landing', expiresAt: null, downloadLimit: null },
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        matterId: 'm-1',
        creatorId: 'creator-1',
        kind: 'landing',
        password: 'pw',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
        downloadLimit: 5,
      }),
    )
  })

  it('does not dispatch notifications when there are no recipients', async () => {
    const { deps, createNotification } = makeDeps()
    await createShare(deps, { userId: 'creator-1', input: baseInput })
    await flushDispatch()
    expect(createNotification).not.toHaveBeenCalled()
  })

  it('dispatches share-created notifications when recipients are present', async () => {
    const { deps, createNotification } = makeDeps({
      share: {
        getCreatorIdentity: async () => ({ name: 'Alice' }),
        getMatterName: async () => 'doc.pdf',
      },
    })
    const recipients = [{ recipientUserId: 'u2' }, { recipientEmail: 'b@example.com' }]
    await createShare(deps, {
      userId: 'creator-1',
      input: { ...baseInput, recipients },
    })
    await flushDispatch()
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u2',
        type: 'share_received',
        title: 'Alice shared "doc.pdf" with you',
        refId: 's-1',
      }),
    )
  })

  it.each([
    ['MATTER_NOT_FOUND', 404, 'Matter not found'],
    ['DIRECT_NO_FOLDER', 400, 'Direct shares cannot be folders'],
    ['DIRECT_NO_PASSWORD', 400, 'Direct shares cannot have a password'],
    ['DIRECT_NO_RECIPIENTS', 400, 'Direct shares cannot have recipients'],
  ] as const)('maps CreateShareError %s to a failure outcome without recording activity', async (code, status, message) => {
    const create = vi.fn(async () => {
      throw new CreateShareError(code)
    })
    const { deps, createNotification } = makeDeps({ share: { create } })
    const out = await createShare(deps, { userId: 'creator-1', input: baseInput })
    expectError(out, status, code, message)
    await flushDispatch()
    expect(createNotification).not.toHaveBeenCalled()
  })

  it('rethrows a non-CreateShareError', async () => {
    const create = vi.fn(async () => {
      throw new Error('db down')
    })
    const { deps } = makeDeps({ share: { create } })
    await expect(createShare(deps, { userId: 'creator-1', input: baseInput })).rejects.toThrow('db down')
  })
})

// ─── setSharePrivacy ─────────────────────────────────────────────────────────

describe('setSharePrivacy', () => {
  it('returns forbidden when the requester is not the creator', async () => {
    const setPrivacy = vi.fn()
    const { deps } = makeDeps({ share: { setPrivacy } })
    expectError(
      await setSharePrivacy(deps, { token: 'sk_token1', userId: 'someone-else', private: true }),
      403,
      undefined,
      'Forbidden',
    )
    expect(setPrivacy).not.toHaveBeenCalled()
  })

  it('returns ineligible for targeted or direct shares', async () => {
    const withRecipients = okResolution({
      recipients: [{ id: 'r-1', shareId: 's-1', recipientUserId: 'u2', recipientEmail: null, createdAt: new Date(0) }],
    })
    const { deps } = makeDeps({ share: { resolveByToken: async () => withRecipients } })
    expectError(
      await setSharePrivacy(deps, { token: 'sk_token1', userId: 'creator-1', private: true }),
      400,
      'SHARE_PRIVACY_INELIGIBLE',
      'Only untargeted landing shares have configurable privacy',
    )
  })
})

// ─── revokeShare ─────────────────────────────────────────────────────────────

describe('revokeShare', () => {
  it('returns not_found when the token does not resolve', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => ({ status: 'not_found' }) } })
    expectError(await revokeShare(deps, { token: 't', userId: 'creator-1' }), 404, undefined, 'Not found')
  })

  it('returns not_found when the share is already revoked', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => ({ status: 'revoked' }) } })
    expectError(await revokeShare(deps, { token: 't', userId: 'creator-1' }), 404, undefined, 'Not found')
  })

  it('returns forbidden when the requester is not the creator', async () => {
    const { deps } = makeDeps()
    expectError(await revokeShare(deps, { token: 't', userId: 'someone-else' }), 403, undefined, 'Forbidden')
  })

  it('returns not_found when the scoped revoke loses the race', async () => {
    const { deps } = makeDeps({ share: { revokeByToken: async () => false } })
    expectError(await revokeShare(deps, { token: 'sk_token1', userId: 'creator-1' }), 404, undefined, 'Not found')
  })

  it('still revokes a share whose matter is trashed (trashing does not cascade)', async () => {
    const revokeByToken = vi.fn(async () => true)
    const { deps } = makeDeps({ share: { resolveByToken: async () => trashedResolution(), revokeByToken } })
    const out = await revokeShare(deps, { token: 'sk_token1', userId: 'creator-1' })
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected ok')
    expect(out.dto).toMatchObject({ token: 'sk_token1', status: 'revoked', id: 's-1', creatorId: 'creator-1' })
    expect(revokeByToken).toHaveBeenCalledWith('sk_token1', 'creator-1')
  })

  it('returns forbidden for a non-creator even when the matter is trashed', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => trashedResolution() } })
    expectError(await revokeShare(deps, { token: 'sk_token1', userId: 'someone-else' }), 403, undefined, 'Forbidden')
  })

  it('revokes and returns the revoked creator view', async () => {
    const revokeByToken = vi.fn(async () => true)
    const { deps } = makeDeps({ share: { revokeByToken } })
    const out = await revokeShare(deps, { token: 'sk_token1', userId: 'creator-1' })
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected ok')
    expect(out.dto).toMatchObject({
      token: 'sk_token1',
      status: 'revoked',
      id: 's-1',
      creatorId: 'creator-1',
      recipients: [],
    })
    expect(revokeByToken).toHaveBeenCalledWith('sk_token1', 'creator-1')
  })
})

// ─── saveShare ───────────────────────────────────────────────────────────────

describe('saveShare', () => {
  const baseParams = {
    token: 'sk_token1',
    currentUserId: 'u1',
    targetParent: '',
    accessCookie: undefined,
    createdBy: { type: 'oauth' as const, ref: 'agent-1', issuer: 'https://realm.example.com' },
  }

  it('returns matter_trashed when the share target was trashed', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => trashedResolution() } })
    expectError(await saveShare(deps, baseParams), 410, undefined, 'Share target has been deleted')
  })

  it('returns not_found for a revoked/missing share', async () => {
    const { deps } = makeDeps({ share: { resolveByToken: async () => ({ status: 'revoked' }) } })
    expectError(await saveShare(deps, baseParams), 404, undefined, 'Share not found')
  })

  it('returns direct_forbidden for a direct share', async () => {
    const direct = { ...landingShare, kind: 'direct' } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: direct }) } })
    expectError(
      await saveShare(deps, baseParams),
      400,
      'DIRECT_SAVE_FORBIDDEN',
      'Direct link shares cannot be saved. Ask the sender for a landing share.',
    )
  })

  it('returns password_required when the gate blocks a non-recipient', async () => {
    const pw = { ...landingShare, passwordHash: 'hash' } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: pw }) } })
    expectError(
      await saveShare(deps, { ...baseParams, accessCookie: undefined }),
      401,
      undefined,
      'Authentication required for password-protected share',
    )
  })

  it('bypasses the password gate when the cookie is ok', async () => {
    const pw = { ...landingShare, passwordHash: 'hash' } as ShareRecord
    const { deps } = makeDeps({ share: { resolveByToken: async () => okResolution({ share: pw }) } })
    const out = await saveShare(deps, { ...baseParams, accessCookie: 'ok' })
    expect(out.ok).toBe(true)
  })

  it('copies via saveShareToDrive and returns the result on success', async () => {
    const saved = [{ ...fileMatter, id: 'copy-1' }] as Matter[]
    saveToDrive.mockResolvedValue({ saved, skipped: [{ name: 'x', reason: 'conflict' }] })
    const { deps } = makeDeps()
    const out = await saveShare(deps, { ...baseParams, targetParent: 'dest' })
    expect(out).toEqual({ ok: true, result: { saved, skipped: [{ name: 'x', reason: 'conflict' }] } })
    expect(saveToDrive).toHaveBeenCalledWith(deps, {
      matter: fileMatter,
      currentUserId: 'u1',
      targetParent: 'dest',
      createdBy: { type: 'oauth', ref: 'agent-1', issuer: 'https://realm.example.com' },
    })
  })
})
