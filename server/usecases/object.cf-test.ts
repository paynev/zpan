import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirType } from '../../shared/constants'
import { generateId } from '../../shared/ids'
import type { CreateShareInput } from '../../shared/schemas/share'
import { S3Service } from '../adapters/gateways/s3'
import { createMatterRepo } from '../adapters/repos/matter'
import { createShareRepo } from '../adapters/repos/share'
import { createStorageRepo } from '../adapters/repos/storage'
import { createStorageUsageRepo } from '../adapters/repos/storage-usage'
import { matters } from '../db/schema'
import { createCloudflarePlatform } from '../platform/cloudflare'
import type { Database } from '../platform/interface'
import { type SaveShareInput, type SaveToDriveDeps, saveShareToDrive as saveShareToDriveUseCase } from './object'

function buildDb() {
  return createCloudflarePlatform(env).db
}

const createShare = (db: Database, input: CreateShareInput) => createShareRepo(db).create(input)
const resolveShareByToken = (db: Database, token: string) => createShareRepo(db).resolveByToken(token)
const revokeShareByToken = (db: Database, token: string, creatorId: string) =>
  createShareRepo(db).revokeByToken(token, creatorId)

function saveToDriveDeps(db: Database): SaveToDriveDeps {
  return {
    s3: new S3Service(),
    storages: createStorageRepo(db),
    storageUsage: createStorageUsageRepo(db),
    share: createShareRepo(db),
    matter: createMatterRepo(db),
  }
}
const saveShareToDrive = (db: Database, input: SaveShareInput) => saveShareToDriveUseCase(saveToDriveDeps(db), input)

async function seedStorage(db: ReturnType<typeof buildDb>, id: string) {
  await db.run(
    `INSERT OR IGNORE INTO storages (id, bucket, endpoint, region, access_key, secret_key, file_path, capacity, used, status, created_at, updated_at)
     VALUES ('${id}', 'cf-bucket', 'https://s3.amazonaws.com', 'us-east-1', 'AKIA...', 'secret...', '', 0, 0, 'active', ${Date.now()}, ${Date.now()})`,
  )
}

async function seedMatter(db: ReturnType<typeof buildDb>, dirtype = DirType.FILE) {
  const now = new Date()
  const matter = {
    id: generateId(),
    alias: generateId(10),
    name: `cf-file-${generateId(6)}.pdf`,
    type: dirtype !== DirType.FILE ? 'folder' : 'application/pdf',
    size: 1024,
    dirtype,
    parent: '',
    object: dirtype !== DirType.FILE ? '' : `objects/${generateId()}.pdf`,
    storageId: 'cf-storage-1',
    status: 'active',
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(matters).values(matter)
  return matter
}

// ─── resolveShareByToken on D1 ────────────────────────────────────────────────

describe('[CF] resolveShareByToken', () => {
  it('returns ok for an active landing share', async () => {
    const db = buildDb()
    await seedStorage(db, 'cf-storage-1')
    const matter = await seedMatter(db)

    const share = await createShare(db, {
      matterId: matter.id,
      creatorId: 'cfUser1',
      kind: 'landing',
    })

    const result = await resolveShareByToken(db, share.token)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.share.id).toBe(share.id)
  })

  it('returns revoked when share is revoked', async () => {
    const db = buildDb()
    await seedStorage(db, 'cf-storage-1')
    const matter = await seedMatter(db)

    const share = await createShare(db, { matterId: matter.id, creatorId: 'cfUser2', kind: 'landing' })
    await revokeShareByToken(db, share.token, 'cfUser2')

    const result = await resolveShareByToken(db, share.token)
    expect(result.status).toBe('revoked')
  })

  it('returns matter_trashed when matter is trashed', async () => {
    const db = buildDb()
    await seedStorage(db, 'cf-storage-1')
    const matter = await seedMatter(db)

    const share = await createShare(db, { matterId: matter.id, creatorId: 'cfUser3', kind: 'landing' })
    // Trash = active row with trashedAt set (no 'trashed' status).
    await db.run(`UPDATE matters SET trashed_at = ${Date.now()} WHERE id = '${matter.id}'`)

    const result = await resolveShareByToken(db, share.token)
    expect(result.status).toBe('matter_trashed')
  })
})

// ─── saveShareToDrive on D1 ───────────────────────────────────────────────────

describe('[CF] saveShareToDrive — stream copy via D1', () => {
  beforeEach(() => {
    vi.spyOn(S3Service.prototype, 'copyObject').mockResolvedValue(undefined)
    vi.spyOn(S3Service.prototype, 'streamCopy').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('saves a single file on D1', async () => {
    const db = buildDb()
    await seedStorage(db, 'cf-storage-1')

    const matter = await seedMatter(db)
    await createShare(db, { matterId: matter.id, creatorId: 'cfU1', kind: 'landing' })

    const result = await saveShareToDrive(db, {
      matter,
      currentUserId: 'cfU2',
      targetParent: '',
    })

    expect(result.saved).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)
    expect(result.saved[0].status).toBe('active')
    expect(result.saved[0].object).toMatch(/^cfU2\/\d{8}\/[A-Za-z0-9]{17}\.pdf$/)
  })

  it('does not increment downloads counter after save', async () => {
    const db = buildDb()
    await seedStorage(db, 'cf-storage-1')

    const matter = await seedMatter(db)
    const share = await createShare(db, { matterId: matter.id, creatorId: 'cfU3', kind: 'landing' })

    const downloadsBefore = share.downloads

    await saveShareToDrive(db, {
      matter,
      currentUserId: 'cfU4',
      targetParent: '',
    })

    // Verify by re-querying the share
    const updatedShareRows = await db.all<{ downloads: number }>(
      `SELECT downloads FROM shares WHERE id = '${share.id}'`,
    )
    expect(updatedShareRows[0]?.downloads).toBe(downloadsBefore)
  })

  it('recursively saves a folder tree on D1', async () => {
    const db = buildDb()
    await seedStorage(db, 'cf-storage-1')

    // Create folder structure
    const now = new Date()
    const folder = {
      id: generateId(),
      alias: generateId(10),
      name: 'cf-album',
      type: 'folder',
      size: 0,
      dirtype: DirType.USER_FOLDER,
      parent: '',
      object: '',
      storageId: 'cf-storage-1',
      status: 'active',
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await db.insert(matters).values(folder)

    const file1 = {
      id: generateId(),
      alias: generateId(10),
      name: 'photo1.jpg',
      type: 'image/jpeg',
      size: 500,
      dirtype: DirType.FILE,
      parent: 'cf-album',
      object: `objects/${generateId()}.jpg`,
      storageId: 'cf-storage-1',
      status: 'active',
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await db.insert(matters).values(file1)

    await createShare(db, { matterId: folder.id, creatorId: 'cfU5', kind: 'landing' })

    const result = await saveShareToDrive(db, {
      matter: folder,
      currentUserId: 'cfU6',
      targetParent: '',
    })

    // 1 root folder + 1 file = 2
    expect(result.saved).toHaveLength(2)
    expect(result.skipped).toHaveLength(0)
  })
})
