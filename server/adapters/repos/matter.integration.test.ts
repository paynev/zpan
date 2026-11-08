import { sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { describe, expect, it } from 'vitest'
import { createTestApp } from '../../test/setup.js'
import { type ConfirmUploadOptions, confirmUpload as confirmUploadUsecase } from '../../usecases/object'
import type { UpdateMatterInput } from '../../usecases/ports'
import { createMatterRepo } from './matter.js'
import { createStorageUsageRepo } from './storage-usage.js'

type TestDbForRepo = Awaited<ReturnType<typeof createTestApp>>['db']

// Thin adapters preserving the former matter service signatures.
function confirmUpload(db: TestDbForRepo, id: string, opts: ConfirmUploadOptions = {}) {
  return confirmUploadUsecase(
    {
      matter: createMatterRepo(db),
      storageUsage: createStorageUsageRepo(db),
    },
    id,
    opts,
  )
}
function listTrashedRoots(db: TestDbForRepo) {
  return createMatterRepo(db).listTrashedRoots()
}
function updateMatter(db: TestDbForRepo, id: string, input: UpdateMatterInput) {
  return createMatterRepo(db).update(id, input)
}

type TestDb = Awaited<ReturnType<typeof createTestApp>>['db']

async function insertStorage(db: TestDb, opts: { id?: string; used?: number } = {}) {
  const id = opts.id ?? 'st-1'
  const now = Date.now()
  await db.run(sql`
    INSERT INTO storages (id, bucket, endpoint, region, access_key, secret_key, file_path, capacity, used, status, created_at, updated_at)
    VALUES (${id}, 'test-bucket', 'https://s3.example.com', 'us-east-1',
            'AKID', 'SECRET', '$UID/$RAW_NAME', 0, ${opts.used ?? 0}, 'active', ${now}, ${now})
  `)
  return id
}

async function insertDraftFile(db: TestDb, opts: { id?: string; size?: number; storageId?: string } = {}) {
  const id = opts.id ?? nanoid()
  const storageId = opts.storageId ?? 'st-1'
  const size = opts.size ?? 100
  const now = Date.now()
  await db.run(sql`
    INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, created_at, updated_at)
    VALUES (${id}, ${`${id}-alias`}, 'file.txt', 'text/plain', ${size}, 0, '', 'some/key.txt', ${storageId}, 'draft', ${now}, ${now})
  `)
  return id
}

// ─── storage usage reconciliation ─────────────────────────────────────────────

describe('storage usage reconciliation', () => {
  it('reconciles active files plus active image hostings', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-rec', used: 9999 })
    const now = Date.now()

    await db.run(sql`
      INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, trashed_at, created_at, updated_at)
      VALUES
        ('active-file', 'active-file-alias', 'active.txt', 'text/plain', 100, 0, '', 'active-key', ${storageId}, 'active', NULL, ${now}, ${now}),
        ('trashed-file', 'trashed-file-alias', 'trashed.txt', 'text/plain', 200, 0, '', 'trashed-key', ${storageId}, 'active', ${now}, ${now}, ${now}),
        ('purged-file', 'purged-file-alias', 'purged.txt', 'text/plain', 999, 0, '', 'purged-key', ${storageId}, 'active', ${now}, ${now}, ${now}),
        ('draft-file', 'draft-file-alias', 'draft.txt', 'text/plain', 300, 0, '', 'draft-key', ${storageId}, 'draft', NULL, ${now}, ${now}),
        ('active-folder', 'active-folder-alias', 'Folder', 'folder', 400, 1, '', '', ${storageId}, 'active', NULL, ${now}, ${now})
    `)
    await db.run(sql`UPDATE matters SET purged_at = ${now} WHERE id = 'purged-file'`)
    await createStorageUsageRepo(db).reconcile([storageId])

    const storageRows = await db.all<{ used: number }>(sql`SELECT used FROM storages WHERE id = ${storageId}`)
    expect(storageRows[0].used).toBe(100)
  })
})

// ─── confirmUpload ────────────────────────────────────────────────────────────

describe('confirmUpload', () => {
  it('returns { matter } with status active and updates storage usage for a draft file with size > 0', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-conf', used: 0 })
    const matterId = await insertDraftFile(db, { id: 'matter-a', size: 500, storageId })

    const result = await confirmUpload(db, matterId, { contentType: 'audio/flac' })

    expect(result.matter).not.toBeNull()
    expect(result.matter?.status).toBe('active')
    expect(result.matter?.type).toBe('audio/flac')

    const matterRows = await db.all<{ type: string }>(sql`SELECT type FROM matters WHERE id = ${matterId}`)
    expect(matterRows[0].type).toBe('audio/flac')

    const storageRows = await db.all<{ used: number }>(sql`SELECT used FROM storages WHERE id = ${storageId}`)
    expect(storageRows[0].used).toBe(500)
  })

  it('does not couple matter activation and storage usage to upload audit writes', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-conf-atomic', used: 0 })
    const matterId = await insertDraftFile(db, { id: 'matter-atomic', size: 500, storageId })
    await db.run(sql`
      CREATE TRIGGER reject_upload_fact
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'upload_confirm'
      BEGIN
        SELECT RAISE(ABORT, 'reject_upload_fact');
      END
    `)

    await expect(confirmUpload(db, matterId)).resolves.toMatchObject({
      matter: { id: matterId, status: 'active' },
    })

    const matterRows = await db.all<{ status: string }>(sql`SELECT status FROM matters WHERE id = ${matterId}`)
    expect(matterRows).toEqual([{ status: 'active' }])
    const storageRows = await db.all<{ used: number }>(sql`SELECT used FROM storages WHERE id = ${storageId}`)
    expect(storageRows).toEqual([{ used: 500 }])
  })

  it('returns { matter } and does not increment usage when file size is 0', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-conf2' })
    const matterId = await insertDraftFile(db, { id: 'matter-b', size: 0, storageId })

    const result = await confirmUpload(db, matterId)

    expect(result.matter?.status).toBe('active')
    const storageRows = await db.all<{ used: number }>(sql`SELECT used FROM storages WHERE id = ${storageId}`)
    // `used` is a projection reconciled from active bytes, so a 0-byte file
    // leaves it at 0 instead of adding an increment.
    expect(storageRows[0].used).toBe(0)
  })

  it('returns { matter: null } for a non-existent matter', async () => {
    const { db } = await createTestApp()
    const result = await confirmUpload(db, 'nonexistent')
    expect(result.matter).toBeNull()
  })

  it('returns { matter: null } for a matter not in draft status', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-conf3' })
    const now = Date.now()
    await db.run(sql`
      INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, created_at, updated_at)
      VALUES ('matter-active', 'matter-active-alias', 'file.txt', 'text/plain', 100, 0, '', 'key', ${storageId}, 'active', ${now}, ${now})
    `)

    const result = await confirmUpload(db, 'matter-active')
    expect(result.matter).toBeNull()
  })
})

describe('cancelDraft', () => {
  it('deletes the draft without writing a duplicate cancel fact', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-cancel-atomic', used: 0 })
    const matterId = await insertDraftFile(db, { id: 'matter-cancel-atomic', size: 500, storageId })
    await expect(createMatterRepo(db).cancelDraft(matterId)).resolves.toMatchObject({ id: matterId })

    const matterRows = await db.all<{ status: string }>(sql`SELECT status FROM matters WHERE id = ${matterId}`)
    expect(matterRows).toEqual([])
    const eventRows = await db.all(sql`SELECT id FROM audit_events WHERE action = 'upload_cancel'`)
    expect(eventRows).toEqual([])
  })
})

// ─── updateMatter — folder-into-itself error ──────────────────────────────────

describe('updateMatter', () => {
  it('throws when moving a folder into itself', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-upd1' })
    const now = Date.now()
    // Insert a folder
    await db.run(sql`
      INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, created_at, updated_at)
      VALUES ('folder-self', 'folder-self-alias', 'MyFolder', 'folder', 0, 1, '', '', ${storageId}, 'active', ${now}, ${now})
    `)

    await expect(updateMatter(db, 'folder-self', { parent: 'MyFolder' })).rejects.toThrow(
      'Cannot move a folder into itself or its subfolder',
    )
  })

  it('throws when moving a folder into its own subfolder', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-upd2' })
    const now = Date.now()
    await db.run(sql`
      INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, created_at, updated_at)
      VALUES ('folder-sub', 'folder-sub-alias', 'Root', 'folder', 0, 1, '', '', ${storageId}, 'active', ${now}, ${now})
    `)

    await expect(updateMatter(db, 'folder-sub', { parent: 'Root/sub' })).rejects.toThrow(
      'Cannot move a folder into itself or its subfolder',
    )
  })
})

// ─── listTrashedRoots ─────────────────────────────────────────────────────────

async function insertTrashedMatter(
  db: TestDb,
  opts: {
    id: string
    alias: string
    name: string
    parent: string
    dirtype: number
    storageId: string
    trashedAt?: number
    createdAt?: number
  },
) {
  const now = Date.now()
  const trashedAt = opts.trashedAt ?? now
  const createdAt = opts.createdAt ?? now
  await db.run(sql`
    INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, trashed_at, created_at, updated_at)
    VALUES (${opts.id}, ${opts.alias}, ${opts.name}, 'text/plain', 0, ${opts.dirtype}, ${opts.parent}, '', ${opts.storageId}, 'active', ${trashedAt}, ${createdAt}, ${now})
  `)
}

describe('listTrashedRoots', () => {
  it('returns only the top-level trashed folder when a folder and its child file are both trashed', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-trash1' })

    // Folder "A" at root, child file "A/file.txt"
    await insertTrashedMatter(db, {
      id: 'folder-a',
      alias: 'folder-a-alias',
      name: 'A',
      parent: '',
      dirtype: 1,
      storageId,
    })
    await insertTrashedMatter(db, {
      id: 'file-in-a',
      alias: 'file-in-a-alias',
      name: 'file.txt',
      parent: 'A',
      dirtype: 0,
      storageId,
    })

    const roots = await listTrashedRoots(db)

    expect(roots).toHaveLength(1)
    expect(roots[0].id).toBe('folder-a')
  })

  it('does not return the child file when it is nested inside a trashed folder', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-trash2' })

    await insertTrashedMatter(db, {
      id: 'folder-b',
      alias: 'folder-b-alias',
      name: 'B',
      parent: '',
      dirtype: 1,
      storageId,
    })
    await insertTrashedMatter(db, {
      id: 'file-in-b',
      alias: 'file-in-b-alias',
      name: 'notes.txt',
      parent: 'B',
      dirtype: 0,
      storageId,
    })

    const roots = await listTrashedRoots(db)
    const ids = roots.map((m) => m.id)

    expect(ids).not.toContain('file-in-b')
  })

  it('orders independent roots by trashed time and then creation time', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-trash3' })

    await insertTrashedMatter(db, {
      id: 'item-x',
      alias: 'item-x-alias',
      name: 'X',
      parent: '',
      dirtype: 0,
      storageId,
      trashedAt: 1_000,
      createdAt: 1_000,
    })
    await insertTrashedMatter(db, {
      id: 'item-y',
      alias: 'item-y-alias',
      name: 'Y',
      parent: '',
      dirtype: 0,
      storageId,
      trashedAt: 2_000,
      createdAt: 1_000,
    })
    await insertTrashedMatter(db, {
      id: 'item-z',
      alias: 'item-z-alias',
      name: 'Z',
      parent: '',
      dirtype: 0,
      storageId,
      trashedAt: 2_000,
      createdAt: 2_000,
    })

    const roots = await listTrashedRoots(db)

    expect(roots.map((matter) => matter.id)).toEqual(['item-z', 'item-y', 'item-x'])
  })

  it('returns an empty array when no trashed items exist', async () => {
    const { db } = await createTestApp()

    const roots = await listTrashedRoots(db)

    expect(roots).toHaveLength(0)
  })

  it('returns deeply-nested trashed folders that are themselves roots (parent folder not trashed)', async () => {
    const { db } = await createTestApp()
    const storageId = await insertStorage(db, { id: 'st-trash5' })

    // Only the subfolder "Docs/Archive" is trashed — its parent "Docs" is not
    await insertTrashedMatter(db, {
      id: 'archive-folder',
      alias: 'archive-folder-alias',
      name: 'Archive',
      parent: 'Docs',
      dirtype: 1,
      storageId,
    })
    await insertTrashedMatter(db, {
      id: 'file-in-archive',
      alias: 'file-in-archive-alias',
      name: 'report.pdf',
      parent: 'Docs/Archive',
      dirtype: 0,
      storageId,
    })

    const roots = await listTrashedRoots(db)

    expect(roots).toHaveLength(1)
    expect(roots[0].id).toBe('archive-folder')
  })
})
