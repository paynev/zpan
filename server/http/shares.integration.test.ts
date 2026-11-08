import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE62_PATTERN, generateId, SHARE_TOKEN_PATTERN } from '../../shared/ids'
import { S3Service } from '../adapters/gateways/s3.js'
import { createShareRepo } from '../adapters/repos/share'
import { auditEvents, shareRecipients, shares } from '../db/schema.js'
import { authedHeaders, createTestApp } from '../test/setup.js'

type TestApp = Awaited<ReturnType<typeof createTestApp>>['app']
type TestDb = Awaited<ReturnType<typeof createTestApp>>['db']
type TestAuth = Awaited<ReturnType<typeof createTestApp>>['auth']

// ─── Helpers ──────────────────────────────────────────────────────────────────

const validStorage = {
  id: 'StShareTest',
  bucket: 'test-bucket',
  endpoint: 'https://s3.amazonaws.com',
  region: 'us-east-1',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

async function insertStorage(db: TestDb) {
  const now = Date.now()
  await db.run(sql`
    INSERT OR IGNORE INTO storages (id, bucket, endpoint, region, access_key, secret_key, file_path, capacity, used, status, created_at, updated_at)
    VALUES (${validStorage.id}, ${validStorage.bucket}, ${validStorage.endpoint}, ${validStorage.region}, ${validStorage.accessKey}, ${validStorage.secretKey}, '', 0, 0, 'active', ${now}, ${now})
  `)
}

async function insertFile(
  db: TestDb,
  opts: { id: string; name: string; parent?: string; status?: string; trashedAt?: number },
) {
  const now = Date.now()
  const status = opts.status ?? 'active'
  await db.run(sql`
    INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, trashed_at, created_at, updated_at)
    VALUES (${opts.id}, ${`${opts.id}-alias`}, ${opts.name}, 'text/plain', 100, 0, ${opts.parent ?? ''}, 'some/key.txt', ${validStorage.id}, ${status}, ${opts.trashedAt ?? null}, ${now}, ${now})
  `)
}

async function insertFolder(db: TestDb, opts: { id: string; name: string; parent?: string; trashedAt?: number }) {
  const now = Date.now()
  await db.run(sql`
    INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, trashed_at, created_at, updated_at)
    VALUES (${opts.id}, ${`${opts.id}-alias`}, ${opts.name}, 'folder', 0, 1, ${opts.parent ?? ''}, '', ${validStorage.id}, 'active', ${opts.trashedAt ?? null}, ${now}, ${now})
  `)
}

async function getUserIdByEmail(db: TestDb, email: string): Promise<string> {
  const rows = await db.all<{ id: string }>(sql`SELECT id FROM user WHERE email = ${email}`)
  return rows[0].id
}

async function getFirstUserId(db: TestDb): Promise<string> {
  const rows = await db.all<{ id: string }>(sql`SELECT id FROM user LIMIT 1`)
  return rows[0].id
}

async function createWebDavApiKey(auth: TestAuth, userId: string): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: better-auth plugin API is not fully typed
  const result = (await (auth.api as any).createApiKey({
    body: {
      configId: 'webdav',
      name: 'test-webdav-key',
      userId,
    },
  })) as { key: string }
  return result.key
}

async function createShare(app: TestApp, headers: Record<string, string>, body: Record<string, unknown>) {
  return app.request('/api/shares', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function getShareIdByToken(db: TestDb, token: string): Promise<string> {
  const rows = await db.select({ id: shares.id }).from(shares).where(eq(shares.token, token))
  return rows[0]?.id ?? ''
}

// ─── POST /api/shares auth guard ─────────────────────────────────────────────

describe('POST /api/shares (auth guard)', () => {
  it('returns 401 without auth [spec: shares/auth-required]', async () => {
    const { app } = await createTestApp()
    const res = await app.request('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matterId: 'x', kind: 'landing' }),
    })
    expect(res.status).toBe(401)
  })
})

// ─── POST /api/shares ─────────────────────────────────────────────────────────

describe('POST /api/shares', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects an unsafe externally supplied matter ID before lookup', async () => {
    const { app } = await createTestApp()
    const headers = await authedHeaders(app)

    const res = await createShare(app, headers, { matterId: 'matter/id', kind: 'landing' })

    expect(res.status).toBe(400)
  })

  it('accepts a historical matter reference but creates only new-format share identities', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    const matterId = 'legacy_matter-id'
    await insertFile(db, { id: matterId, name: 'legacy.txt' })

    const res = await createShare(app, headers, { matterId, kind: 'landing' })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string }
    expect(body.token).toMatch(SHARE_TOKEN_PATTERN)
    const rows = await db
      .select({ id: shares.id, matterId: shares.matterId })
      .from(shares)
      .where(eq(shares.token, body.token))
    expect(rows).toEqual([{ id: expect.stringMatching(BASE62_PATTERN), matterId }])
  })

  it('creates a landing share without password and returns 201 with correct shape [spec: shares/create-landing]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'f1', name: 'doc.txt' })

    const res = await createShare(app, headers, { matterId: 'f1', kind: 'landing' })
    expect(res.status).toBe(201)

    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.token).toBe('string')
    expect(body.kind).toBe('landing')
    expect((body.urls as Record<string, string>).landing).toMatch(/^\/s\//)
    expect((body.urls as Record<string, string>).direct).toBeUndefined()
    // Internal primary key is not exposed in the creation response.
    expect(body.id).toBeUndefined()
  })

  it('creates a landing share with password and stores passwordHash in DB [spec: shares/create-password]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'f2', name: 'secret.txt' })

    const res = await createShare(app, headers, { matterId: 'f2', kind: 'landing', password: 'secret-pass' })
    expect(res.status).toBe(201)

    const body = (await res.json()) as Record<string, unknown>
    const rows = await db
      .select({ passwordHash: shares.passwordHash })
      .from(shares)
      .where(eq(shares.token, body.token as string))
    expect(rows[0]?.passwordHash).toBeTruthy()
  })

  it('creates a landing share with recipients and inserts share_recipients rows [spec: shares/create-recipients]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'f3', name: 'report.txt' })

    const recipients = [{ recipientEmail: 'alice@example.com' }, { recipientEmail: 'bob@example.com' }]

    const res = await createShare(app, headers, { matterId: 'f3', kind: 'landing', recipients })
    expect(res.status).toBe(201)

    const body = (await res.json()) as Record<string, unknown>
    const shareId = await getShareIdByToken(db, body.token as string)

    const rows = await db.select().from(shareRecipients).where(eq(shareRecipients.shareId, shareId))
    expect(rows).toHaveLength(2)
  })

  it('creates a direct share for a file and returns direct url [spec: shares/create-direct]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'f4', name: 'photo.jpg' })

    const res = await createShare(app, headers, { matterId: 'f4', kind: 'direct' })
    expect(res.status).toBe(201)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.kind).toBe('direct')
    expect((body.urls as Record<string, string>).direct).toMatch(/^\/r\/[A-Za-z0-9]+$/)
    expect((body.urls as Record<string, string>).landing).toBeUndefined()
  })

  it('returns 400 with DIRECT_NO_FOLDER when creating direct share for a folder [spec: shares/direct-no-folder]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFolder(db, { id: 'fo1', name: 'My Folder' })

    const res = await createShare(app, headers, { matterId: 'fo1', kind: 'direct' })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: { details: Array<{ reason: string }> } }
    expect(body.error.details[0].reason).toBe('DIRECT_NO_FOLDER')
  })

  it('returns 400 with DIRECT_NO_PASSWORD when creating direct share with password [spec: shares/direct-no-password]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'f5', name: 'file.txt' })

    const res = await createShare(app, headers, { matterId: 'f5', kind: 'direct', password: 'secret' })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: { details: Array<{ reason: string }> } }
    expect(body.error.details[0].reason).toBe('DIRECT_NO_PASSWORD')
  })

  it('returns 404 when matterId does not exist [spec: shares/create-unknown-matter]', async () => {
    const { app } = await createTestApp()
    const headers = await authedHeaders(app)

    const res = await createShare(app, headers, { matterId: 'NonexistentMatter', kind: 'landing' })
    expect(res.status).toBe(404)

    const body = (await res.json()) as { error: { details: Array<{ reason: string }> } }
    expect(body.error.details[0].reason).toBe('MATTER_NOT_FOUND')
  })

  it('sets expiresAt when provided in request [spec: shares/create-expiry]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'f6', name: 'expire.txt' })

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const res = await createShare(app, headers, {
      matterId: 'f6',
      kind: 'landing',
      expiresAt: futureDate,
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.expiresAt).not.toBeNull()
  })

  it('sets downloadLimit when provided in request [spec: shares/create-download-limit]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'f7', name: 'limited.txt' })

    const res = await createShare(app, headers, {
      matterId: 'f7',
      kind: 'landing',
      downloadLimit: 5,
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.downloadLimit).toBe(5)
  })

  it('creates an eligible landing share as public by default [spec: shares/create-public]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'Profilecreate', name: 'homepage.txt' })

    const res = await createShare(app, headers, {
      matterId: 'Profilecreate',
      kind: 'landing',
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string; private: boolean }
    expect(body.private).toBe(false)
    const rows = await db
      .select({ private: shares.private, status: shares.status })
      .from(shares)
      .where(eq(shares.token, body.token))
    expect(rows[0]).toEqual({ private: false, status: 'active' })
  })

  it('accepts private creation without changing direct or targeted eligibility', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'Profileineligible', name: 'private.txt' })

    const direct = await createShare(app, headers, {
      matterId: 'Profileineligible',
      kind: 'direct',
      private: true,
    })
    expect(direct.status).toBe(201)

    const targeted = await createShare(app, headers, {
      matterId: 'Profileineligible',
      kind: 'landing',
      recipients: [{ recipientEmail: 'private@example.com' }],
      private: true,
    })
    expect(targeted.status).toBe(201)
  })

  it('returns 400 with DIRECT_NO_RECIPIENTS when creating direct share with recipients [spec: shares/direct-no-recipients]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    const matterId = generateId()
    await insertFile(db, { id: matterId, name: 'file.txt' })

    const res = await createShare(app, headers, {
      matterId,
      kind: 'direct',
      recipients: [{ recipientEmail: 'someone@example.com' }],
    })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: { details: Array<{ reason: string }> } }
    expect(body.error.details[0].reason).toBe('DIRECT_NO_RECIPIENTS')
  })

  it('returns 500 when createShare throws an unexpected error', async () => {
    const { app, db, deps } = await createTestApp()
    const headers = await authedHeaders(app)
    const matterId = generateId()
    await insertFile(db, { id: matterId, name: 'file.txt' })

    vi.spyOn(deps.share, 'create').mockRejectedValueOnce(new Error('unexpected db error'))

    const res = await createShare(app, headers, { matterId, kind: 'landing' })
    expect(res.status).toBe(500)
  })

  it('returns 201 even when dispatchShareCreated rejects [spec: shares/create-notify-best-effort]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    const matterId = generateId()
    await insertFile(db, { id: matterId, name: 'file.txt' })

    const notifService = await import('../usecases/share.js')
    vi.spyOn(notifService, 'dispatchShareCreated').mockRejectedValueOnce(new Error('dispatch failed'))

    const res = await createShare(app, headers, {
      matterId,
      kind: 'landing',
      recipients: [{ recipientEmail: 'someone@example.com' }],
    })
    expect(res.status).toBe(201)
  })
})

// ─── PUT /api/shares/:token/privacy ──────────────────────────────────────────

function privacyRequest(app: TestApp, token: string, isPrivate: boolean, headers?: Record<string, string>) {
  return app.request(`/api/shares/${token}/privacy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ private: isPrivate }),
  })
}

describe('share privacy mutation', () => {
  it('requires authentication', async () => {
    const { app } = await createTestApp()
    expect((await privacyRequest(app, 'unknown', true)).status).toBe(401)
  })

  it('lets only the owner make a landing share private or public without revoking it [spec: shares/privacy-owner] [spec: shares/privacy-authorization] [spec: shares/privacy-preserves-access]', async () => {
    const { app, db } = await createTestApp()
    const ownerHeaders = await authedHeaders(app, `Profileowner${generateId()}@example.com`)
    await insertStorage(db)
    await insertFile(db, { id: 'Profiletoggle', name: 'toggle.txt' })
    const created = await createShare(app, ownerHeaders, { matterId: 'Profiletoggle', kind: 'landing' })
    const token = ((await created.json()) as { token: string }).token
    const otherHeaders = await authedHeaders(app, `Profileother${generateId()}@example.com`)

    expect((await privacyRequest(app, token, true, otherHeaders)).status).toBe(403)

    const madePrivate = await privacyRequest(app, token, true, ownerHeaders)
    expect(madePrivate.status).toBe(200)
    expect(await madePrivate.json()).toEqual({ private: true })

    const madePublic = await privacyRequest(app, token, false, ownerHeaders)
    expect(madePublic.status).toBe(200)
    expect(await madePublic.json()).toEqual({ private: false })
    const rows = await db
      .select({ private: shares.private, status: shares.status })
      .from(shares)
      .where(eq(shares.token, token))
    expect(rows[0]).toEqual({ private: false, status: 'active' })

    const landing = await app.request(`/api/shares/${token}`)
    expect(landing.status).toBe(200)
  })

  it('rejects privacy mutations for direct and recipient-targeted shares [spec: shares/privacy-ineligible]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app, `Profileineligibleowner${generateId()}@example.com`)
    await insertStorage(db)
    await insertFile(db, { id: 'Profiledirecttoggle', name: 'direct.txt' })
    await insertFile(db, { id: 'Profiletargetedtoggle', name: 'targeted.txt' })

    const directCreated = await createShare(app, headers, { matterId: 'Profiledirecttoggle', kind: 'direct' })
    const directToken = ((await directCreated.json()) as { token: string }).token
    const targetedCreated = await createShare(app, headers, {
      matterId: 'Profiletargetedtoggle',
      kind: 'landing',
      recipients: [{ recipientEmail: 'recipient@example.com' }],
    })
    const targetedToken = ((await targetedCreated.json()) as { token: string }).token

    for (const token of [directToken, targetedToken]) {
      const res = await privacyRequest(app, token, true, headers)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { details: Array<{ reason: string }> } }
      expect(body.error.details[0]?.reason).toBe('SHARE_PRIVACY_INELIGIBLE')
    }
  })

  it('does not let user-wide WebDAV app passwords mutate share privacy', async () => {
    const { app, db, auth } = await createTestApp()
    const ownerHeaders = await authedHeaders(app)
    await insertStorage(db)
    const userId = await getUserIdByEmail(db, 'test@example.com')
    await insertFile(db, { id: 'WebdavShareprivacy', name: 'WebdavShareprivacy.txt' })
    const created = await createShare(app, ownerHeaders, { matterId: 'WebdavShareprivacy', kind: 'landing' })
    const token = ((await created.json()) as { token: string }).token
    const key = await createWebDavApiKey(auth, userId)

    const res = await privacyRequest(app, token, true, { Authorization: `Bearer ${key}` })

    expect(res.status).toBe(403)
    const rows = await db.select({ private: shares.private }).from(shares).where(eq(shares.token, token))
    expect(rows[0]?.private).toBe(false)
  })
})

// ─── GET /api/shares auth guard ───────────────────────────────────────────────

describe('GET /api/shares (auth guard)', () => {
  it('returns 401 without auth', async () => {
    const { app } = await createTestApp()
    const res = await app.request('/api/shares')
    expect(res.status).toBe(401)
  })
})

// ─── GET /api/shares ──────────────────────────────────────────────────────────

describe('GET /api/shares', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty list for a new user with no shares [spec: shares/list-empty]', async () => {
    const { app } = await createTestApp()
    const headers = await authedHeaders(app)

    const res = await app.request('/api/shares', { headers })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { items: unknown[]; nextPageToken: string | null }
    expect(body.items).toHaveLength(0)
    expect(body.nextPageToken).toBeNull()
  })

  it('continues shares with an opaque page token [spec: shares/list-pagination]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'pg1', name: 'a.txt' })
    await insertFile(db, { id: 'pg2', name: 'b.txt' })

    await createShare(app, headers, { matterId: 'pg1', kind: 'landing' })
    await createShare(app, headers, { matterId: 'pg2', kind: 'landing' })

    const first = await app.request('/api/shares?pageSize=1', { headers })
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { items: Array<{ id: string }>; nextPageToken: string | null }
    expect(firstBody.items).toHaveLength(1)
    expect(firstBody.nextPageToken).toEqual(expect.any(String))

    const second = await app.request(`/api/shares?pageSize=1&pageToken=${firstBody.nextPageToken}`, { headers })
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as { items: Array<{ id: string }>; nextPageToken: string | null }
    expect(secondBody.items).toHaveLength(1)
    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id)
    expect(secondBody.nextPageToken).toBeNull()
  })

  it('does not return shares belonging to another user [spec: shares/list-isolation]', async () => {
    const { app, db } = await createTestApp()
    await insertStorage(db)

    // User A creates a share
    const headersA = await authedHeaders(app, `a-${generateId()}@example.com`)
    await insertFile(db, { id: 'oa1', name: 'only-a.txt' })
    await createShare(app, headersA, { matterId: 'oa1', kind: 'landing' })

    // User B lists their shares
    const headersB = await authedHeaders(app, `b-${generateId()}@example.com`)
    const res = await app.request('/api/shares', { headers: headersB })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toHaveLength(0)
  })

  it('each list item has matter and recipientCount fields', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'rm1', name: 'has-recipients.txt' })

    await createShare(app, headers, {
      matterId: 'rm1',
      kind: 'landing',
      recipients: [{ recipientEmail: 'x@example.com' }],
    })

    const res = await app.request('/api/shares', { headers })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { items: Array<Record<string, unknown>> }
    const item = body.items[0]
    expect(item).toHaveProperty('matter')
    const matter = item.matter as Record<string, unknown>
    expect(typeof matter.name).toBe('string')
    expect(typeof matter.type).toBe('string')
    expect(typeof matter.dirtype).toBe('number')
    expect(typeof item.recipientCount).toBe('number')
    expect(item.recipientCount).toBe(1)
  })

  it('filters shares by status=active [spec: shares/list-filter-status]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'st1', name: 'active.txt' })
    await insertFile(db, { id: 'st2', name: 'revoked.txt' })

    await createShare(app, headers, { matterId: 'st1', kind: 'landing' })
    const res2 = await createShare(app, headers, { matterId: 'st2', kind: 'landing' })
    const body2 = (await res2.json()) as Record<string, unknown>

    // Revoke the second share
    await revokeRequest(app, body2.token as string, headers)

    const resActive = await app.request('/api/shares?status=active', { headers })
    const activeBody = (await resActive.json()) as { items: unknown[] }
    expect(activeBody.items).toHaveLength(1)

    const resRevoked = await app.request('/api/shares?status=revoked', { headers })
    const revokedBody = (await resRevoked.json()) as { items: unknown[] }
    expect(revokedBody.items).toHaveLength(1)
  })
})

// ─── GET /api/shares/:token (creator vs visitor views) ───────────────────────

describe('GET /api/shares/:token', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns full detail including recipients when viewer is the creator [spec: shares/detail-creator]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'gd1', name: 'get-detail.txt' })

    const createRes = await createShare(app, headers, {
      matterId: 'gd1',
      kind: 'landing',
      recipients: [{ recipientEmail: 'r@example.com' }],
    })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    const res = await app.request(`/api/shares/${token}`, { headers })
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.token).toBe(token)
    expect(Array.isArray(body.recipients)).toBe(true)
    expect((body.recipients as unknown[]).length).toBe(1)
    const matter = body.matter as Record<string, unknown>
    expect(matter.name).toBe('get-detail.txt')
    expect(typeof body.id).toBe('string')
    expect(typeof body.rootRef).toBe('string')
  })

  it('returns landing view without recipients or internal ids for non-creator [spec: shares/detail-non-creator]', async () => {
    const { app, db } = await createTestApp()
    await insertStorage(db)

    const headersA = await authedHeaders(app, `ownerA-${generateId()}@example.com`)
    await insertFile(db, { id: 'ga1', name: 'owned-by-a.txt' })
    const createRes = await createShare(app, headersA, { matterId: 'ga1', kind: 'landing' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    const headersB = await authedHeaders(app, `otherB-${generateId()}@example.com`)
    const res = await app.request(`/api/shares/${token}`, { headers: headersB })
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.token).toBe(token)
    expect(body.recipients).toBeUndefined()
    expect(body.id).toBeUndefined()
    expect(body.orgId).toBeUndefined()
    expect(body.matterId).toBeUndefined()
    expect(body.creatorId).toBeUndefined()
  })

  it('returns 404 for a non-existent token [spec: shares/detail-not-found]', async () => {
    const { app } = await createTestApp()
    const res = await app.request('/api/shares/sMissing0001')
    expect(res.status).toBe(404)
  })

  it('returns 404 for direct share when viewer is not the creator', async () => {
    const { app, db } = await createTestApp()
    await insertStorage(db)

    const headersA = await authedHeaders(app, `downer-${generateId()}@example.com`)
    await insertFile(db, { id: 'dgd1', name: 'direct.bin' })
    const createRes = await createShare(app, headersA, { matterId: 'dgd1', kind: 'direct' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    const res = await app.request(`/api/shares/${token}`)
    expect(res.status).toBe(404)
  })

  it('returns direct share detail with creator-only fields when viewer is the creator', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'dgd2', name: 'direct2.bin' })
    const createRes = await createShare(app, headers, { matterId: 'dgd2', kind: 'direct' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    const res = await app.request(`/api/shares/${token}`, { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.kind).toBe('direct')
    expect(typeof body.id).toBe('string')
    expect(typeof body.creatorId).toBe('string')
    expect(typeof body.createdAt).toBe('string')
    expect(Array.isArray(body.recipients)).toBe(true)
  })

  it('does not increment views when viewer is the creator [spec: shares/no-self-view-count]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'nv1', name: 'no-view-count.txt' })

    const createRes = await createShare(app, headers, { matterId: 'nv1', kind: 'landing' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    await app.request(`/api/shares/${token}`, { headers })
    await app.request(`/api/shares/${token}`, { headers })

    const rows = await db.select({ views: shares.views }).from(shares).where(eq(shares.token, token))
    expect(rows[0]?.views).toBe(0)
  })
})

// ─── POST /api/shares/:token/objects (save-to-drive) ─────────────────────────

describe('POST /api/shares/:token/objects', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(S3Service.prototype, 'copyObject').mockResolvedValue(undefined)
    vi.spyOn(S3Service.prototype, 'streamCopy').mockResolvedValue(undefined)
  })

  it('returns 404 when share token does not exist', async () => {
    const { app } = await createTestApp()
    const headers = await authedHeaders(app)

    const res = await app.request('/api/shares/sMissing0001/objects', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      // Saves always target the authenticated admin's own drive.
      body: JSON.stringify({ targetParent: '' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 with DIRECT_SAVE_FORBIDDEN for direct shares [spec: shares/save-direct-forbidden]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'Svdirect', name: 'direct-file.txt' })
    const createRes = await createShare(app, headers, { matterId: 'Svdirect', kind: 'direct' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    const res = await app.request(`/api/shares/${token}/objects`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetParent: '' }),
    })
    expect(res.status).toBe(400)

    const body = (await res.json()) as { error: { details: Array<{ reason: string }> } }
    expect(body.error.details[0].reason).toBe('DIRECT_SAVE_FORBIDDEN')
  })

  it('returns 410 when the shared matter has been trashed [spec: shares/save-trashed-gone]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'Svtrashed', name: 'will-trash.txt' })
    const createRes = await createShare(app, headers, { matterId: 'Svtrashed', kind: 'landing' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string
    await db.run(sql`UPDATE matters SET trashed_at = ${Date.now()} WHERE id = 'Svtrashed'`)

    const res = await app.request(`/api/shares/${token}/objects`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetParent: '' }),
    })
    expect(res.status).toBe(410)
  })

  it('saves a landing share file to personal drive and returns 201 [spec: shares/save-to-drive]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'Svok', name: 'shareable.txt' })
    const createRes = await createShare(app, headers, { matterId: 'Svok', kind: 'landing' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    const res = await app.request(`/api/shares/${token}/objects`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetParent: '' }),
    })
    expect(res.status).toBe(201)
  })

  it('returns 401 without auth', async () => {
    const { app } = await createTestApp()
    const res = await app.request('/api/shares/sometoken/objects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetParent: '' }),
    })
    expect(res.status).toBe(401)
  })

  it('allows password-protected share save when the user is a listed recipient [spec: shares/save-recipient-bypass]', async () => {
    const { app, db } = await createTestApp()
    const creatorHeaders = await authedHeaders(app)
    await insertStorage(db)
    const recipientHeaders = await authedHeaders(app, 'save-recipient@example.com')
    const recipientId = await getUserIdByEmail(db, 'save-recipient@example.com')
    await insertFile(db, { id: 'Svbypass', name: 'for-recipient.txt' })

    const created = await createShare(app, creatorHeaders, {
      matterId: 'Svbypass',
      kind: 'landing',
      password: 'letmein',
      recipients: [{ recipientUserId: recipientId }],
    })
    expect(created.status).toBe(201)
    const token = ((await created.json()) as { token: string }).token

    const res = await app.request(`/api/shares/${token}/objects`, {
      method: 'POST',
      headers: { ...recipientHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetParent: '' }),
    })
    expect(res.status).toBe(201)
  })

  it('returns 401 for password-protected share when user is not a recipient and no cookie', async () => {
    const { app, db } = await createTestApp()
    const creatorHeaders = await authedHeaders(app)
    await insertStorage(db)
    const otherHeaders = await authedHeaders(app, 'save-norecipient@example.com')
    await insertFile(db, { id: 'Svnorec', name: 'locked.txt' })

    const created = await createShare(app, creatorHeaders, {
      matterId: 'Svnorec',
      kind: 'landing',
      password: 'letmein',
    })
    const token = ((await created.json()) as { token: string }).token

    const res = await app.request(`/api/shares/${token}/objects`, {
      method: 'POST',
      headers: { ...otherHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetParent: '' }),
    })
    expect(res.status).toBe(401)
  })

  it('bypasses 401 for password-protected share when non-recipient has valid sharetk cookie [spec: shares/save-cookie-bypass]', async () => {
    const { app, db } = await createTestApp()
    const creatorHeaders = await authedHeaders(app)
    await insertStorage(db)
    const otherHeaders = await authedHeaders(app, 'save-cookieuser@example.com')
    await insertFile(db, { id: 'Svcookie', name: 'unlocked-by-cookie.txt' })

    const created = await createShare(app, creatorHeaders, {
      matterId: 'Svcookie',
      kind: 'landing',
      password: 'letmein',
    })
    const token = ((await created.json()) as { token: string }).token

    const res = await app.request(`/api/shares/${token}/objects`, {
      method: 'POST',
      headers: {
        ...otherHeaders,
        'Content-Type': 'application/json',
        // Keep the Better Auth session cookie: overriding Cookie would log us out.
        Cookie: `${otherHeaders.Cookie}; sharetk_${token}=ok`,
      },
      body: JSON.stringify({ targetParent: '' }),
    })
    expect(res.status).toBe(201)
  })

  it('still rejects password-protected save when cookie has wrong value', async () => {
    const { app, db } = await createTestApp()
    const creatorHeaders = await authedHeaders(app)
    await insertStorage(db)
    const otherHeaders = await authedHeaders(app, 'save-badcookie@example.com')
    await insertFile(db, { id: 'Svbadcookie', name: 'still-locked.txt' })

    const created = await createShare(app, creatorHeaders, {
      matterId: 'Svbadcookie',
      kind: 'landing',
      password: 'letmein',
    })
    const token = ((await created.json()) as { token: string }).token

    const res = await app.request(`/api/shares/${token}/objects`, {
      method: 'POST',
      headers: {
        ...otherHeaders,
        'Content-Type': 'application/json',
        Cookie: `${otherHeaders.Cookie}; sharetk_${token}=wrong`,
      },
      body: JSON.stringify({ targetParent: '' }),
    })
    expect(res.status).toBe(401)
  })
})

// ─── PUT /api/shares/:token/status ───────────────────────────────────────────

const revokeRequest = (app: TestApp, token: string, headers: HeadersInit) =>
  app.request(`/api/shares/${token}/status`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'revoked' }),
  })

describe('PUT /api/shares/:token/status (auth guard)', () => {
  it('returns 401 without auth', async () => {
    const { app } = await createTestApp()
    const res = await app.request('/api/shares/some-token/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'revoked' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('PUT /api/shares/:token/status', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('creator can revoke their share, gets the revoked view, and DB status flips [spec: shares/revoke]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'del1', name: 'delete-me.txt' })

    const createRes = await createShare(app, headers, { matterId: 'del1', kind: 'landing' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    const res = await revokeRequest(app, token, headers)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; status: string; id?: string }
    expect(body.token).toBe(token)
    expect(body.status).toBe('revoked')
    expect(body.id).toBeTruthy()

    const rows = await db.select({ status: shares.status }).from(shares).where(eq(shares.token, token))
    expect(rows[0]?.status).toBe('revoked')
  })

  it('returns 403 when non-creator tries to revoke a share [spec: shares/revoke-non-creator]', async () => {
    const { app, db } = await createTestApp()
    await insertStorage(db)

    const headersA = await authedHeaders(app, `del-owner-${generateId()}@example.com`)
    await insertFile(db, { id: 'del2', name: 'other-share.txt' })

    const createRes = await createShare(app, headersA, { matterId: 'del2', kind: 'landing' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    const headersB = await authedHeaders(app, `del-other-${generateId()}@example.com`)
    const res = await revokeRequest(app, token, headersB)
    expect(res.status).toBe(403)
  })

  it('returns 404 for non-existent share token', async () => {
    const { app } = await createTestApp()
    const headers = await authedHeaders(app)

    const res = await revokeRequest(app, 'sMissing0001', headers)
    expect(res.status).toBe(404)
  })

  it('returns 404 when revoking an already-revoked share', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'del3', name: 'twice.txt' })

    const createRes = await createShare(app, headers, { matterId: 'del3', kind: 'landing' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    expect((await revokeRequest(app, token, headers)).status).toBe(200)
    expect((await revokeRequest(app, token, headers)).status).toBe(404)
  })

  it('creator can still revoke a share whose matter was trashed (not purged) [spec: shares/revoke-trashed-matter]', async () => {
    const { app, db } = await createTestApp()
    const headers = await authedHeaders(app)
    await insertStorage(db)
    await insertFile(db, { id: 'del4', name: 'trashed-then-revoked.txt' })

    const createRes = await createShare(app, headers, { matterId: 'del4', kind: 'landing' })
    const token = ((await createRes.json()) as Record<string, unknown>).token as string

    // Soft-delete the matter without purging it — the share row stays active.
    await db.run(sql`UPDATE matters SET trashed_at = ${Date.now()} WHERE id = 'del4'`)

    const res = await revokeRequest(app, token, headers)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; status: string }
    expect(body.token).toBe(token)
    expect(body.status).toBe('revoked')

    const rows = await db.select({ status: shares.status }).from(shares).where(eq(shares.token, token))
    expect(rows[0]?.status).toBe('revoked')
  })

  it('does not let user-wide WebDAV app passwords revoke shares', async () => {
    const { app, db, auth } = await createTestApp()
    const ownerHeaders = await authedHeaders(app)
    await insertStorage(db)
    const userId = await getUserIdByEmail(db, 'test@example.com')
    await insertFile(db, { id: 'WebdavSharerevoke', name: 'WebdavSharerevoke.txt' })
    const created = await createShare(app, ownerHeaders, { matterId: 'WebdavSharerevoke', kind: 'landing' })
    const token = ((await created.json()) as { token: string }).token
    const key = await createWebDavApiKey(auth, userId)

    const res = await revokeRequest(app, token, { Authorization: `Bearer ${key}` })

    expect(res.status).toBe(403)
    const rows = await db.select({ status: shares.status }).from(shares).where(eq(shares.token, token))
    expect(rows[0]?.status).toBe('active')
  })
})

describe('GET /api/shares?box=received', () => {
  it('lists shares addressed to the user by id and by email, hiding unrelated shares [spec: shares/received-list]', async () => {
    const { app, db } = await createTestApp()
    const creatorHeaders = await authedHeaders(app)
    const recipientHeaders = await authedHeaders(app, 'recipient@example.com')
    const bystanderHeaders = await authedHeaders(app, 'bystander@example.com')
    await insertStorage(db)
    const recipientId = await getUserIdByEmail(db, 'recipient@example.com')

    await insertFile(db, { id: 'Rcv1', name: 'for-user.txt' })
    await insertFile(db, { id: 'Rcv2', name: 'for-email.txt' })
    await insertFile(db, { id: 'Rcv3', name: 'for-nobody.txt' })

    const byUser = await createShare(app, creatorHeaders, {
      matterId: 'Rcv1',
      kind: 'landing',
      recipients: [{ recipientUserId: recipientId }],
    })
    expect(byUser.status).toBe(201)
    const byEmail = await createShare(app, creatorHeaders, {
      matterId: 'Rcv2',
      kind: 'landing',
      recipients: [{ recipientEmail: 'recipient@example.com' }],
    })
    expect(byEmail.status).toBe(201)
    const unrelated = await createShare(app, creatorHeaders, { matterId: 'Rcv3', kind: 'landing' })
    expect(unrelated.status).toBe(201)

    const res = await app.request('/api/shares?box=received', { headers: recipientHeaders })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ matter: { name: string }; creatorName?: string }>
    }
    expect(body.items).toHaveLength(2)
    expect(body.items.map((item) => item.matter.name).sort()).toEqual(['for-email.txt', 'for-user.txt'])
    expect(body.items[0].creatorName).toBeTruthy()

    const bystander = await app.request('/api/shares?box=received', { headers: bystanderHeaders })
    const bystanderBody = (await bystander.json()) as { items: unknown[] }
    expect(bystanderBody.items).toHaveLength(0)
  })

  it('excludes revoked shares from the received list [spec: shares/received-excludes-revoked]', async () => {
    const { app, db } = await createTestApp()
    const creatorHeaders = await authedHeaders(app)
    const recipientHeaders = await authedHeaders(app, 'revoked-recipient@example.com')
    await insertStorage(db)
    const recipientId = await getUserIdByEmail(db, 'revoked-recipient@example.com')
    await insertFile(db, { id: 'Rcvrevoked', name: 'gone.txt' })

    const created = await createShare(app, creatorHeaders, {
      matterId: 'Rcvrevoked',
      kind: 'landing',
      recipients: [{ recipientUserId: recipientId }],
    })
    const token = ((await created.json()) as Record<string, unknown>).token as string
    const revoke = await revokeRequest(app, token, creatorHeaders)
    expect(revoke.status).toBe(200)

    const res = await app.request('/api/shares?box=received', { headers: recipientHeaders })
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toHaveLength(0)
  })
})

// ─── Public (visitor-facing) share routes ────────────────────────────────────
// Wrapped so the visitor-focused fixtures (presignDownload mock, fetchRootRef)
// stay isolated from the creator-facing helpers above.

describe('Public share routes', () => {
  const MOCK_PRESIGN_URL = 'https://presigned-download.example.com/file'

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(S3Service.prototype, 'presignDownload').mockResolvedValue(MOCK_PRESIGN_URL)
  })

  async function fetchRootRef(app: TestApp, token: string): Promise<string> {
    const res = await app.request(`/api/shares/${token}`)
    const body = (await res.json()) as { rootRef: string }
    return body.rootRef
  }

  // ─── GET /api/shares/:token ───────────────────────────────────────────────────

  describe('GET /api/shares/:token', () => {
    it('returns 404 for unknown token', async () => {
      const { app } = await createTestApp()
      const res = await app.request('/api/shares/sNoSuchTok01')
      expect(res.status).toBe(404)
    })

    it('returns share metadata for visitor and strips internal ids', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'f1', name: 'photo.jpg' })
      const share = await createShareRepo(db).create({ matterId: 'f1', creatorId, kind: 'landing' })

      // Call without auth headers to simulate a public visitor
      const res = await app.request(`/api/shares/${share.token}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.kind).toBe('landing')
      const matter = body.matter as Record<string, unknown>
      expect(matter.name).toBe('photo.jpg')
      expect(matter.type).toBe('text/plain')
      expect(matter.isFolder).toBe(false)
      expect(body.requiresPassword).toBe(false)
      expect(body.expired).toBe(false)
      expect(body.exhausted).toBe(false)
      expect(body.accessibleByUser).toBe(false)
      expect(body.creatorName).toBe('test')
      expect(typeof body.rootRef).toBe('string')
      // Non-creator must not see internal ids
      expect(body.matterId).toBeUndefined()
      expect(body.orgId).toBeUndefined()
      expect(body.recipients).toBeUndefined()
      expect(body.id).toBeUndefined()
    })

    it('increments views for a public visitor', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'f1v', name: 'visit-count.txt' })
      const share = await createShareRepo(db).create({ matterId: 'f1v', creatorId, kind: 'landing' })

      const res = await app.request(`/api/shares/${share.token}`)
      expect(res.status).toBe(200)

      const rows = await db.all<{ views: number }>(sql`SELECT views FROM shares WHERE id = ${share.id}`)
      expect(rows[0]?.views).toBe(1)
    })

    it('deduplicates repeated visitor view requests within a short window', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'f1d', name: 'visit-once.txt' })
      const share = await createShareRepo(db).create({ matterId: 'f1d', creatorId, kind: 'landing' })

      const first = await app.request(`/api/shares/${share.token}`)
      expect(first.status).toBe(200)
      expect(first.headers.get('set-cookie')).toContain(`sharevw_${share.token}=seen`)

      const second = await app.request(`/api/shares/${share.token}`, {
        headers: { Cookie: `sharevw_${share.token}=seen` },
      })
      expect(second.status).toBe(200)

      const rows = await db.all<{ views: number }>(sql`SELECT views FROM shares WHERE id = ${share.id}`)
      expect(rows[0]?.views).toBe(1)
    })

    it('returns 404 for direct share kind (visitor)', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'f2', name: 'direct.txt' })
      const share = await createShareRepo(db).create({ matterId: 'f2', creatorId, kind: 'direct' })

      const res = await app.request(`/api/shares/${share.token}`)
      expect(res.status).toBe(404)
    })

    it('returns 410 for trashed matter', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'f3', name: 'gone.txt', trashedAt: Date.now() })
      const now = Date.now()
      await db.run(sql`
        INSERT INTO shares (id, token, kind, matter_id, creator_id, views, downloads, status, created_at)
        VALUES ('sh-trash', 'sTrashTok001', 'landing', 'f3', ${creatorId}, 0, 0, 'active', ${now})
      `)

      const res = await app.request('/api/shares/sTrashTok001')
      expect(res.status).toBe(410)
    })

    it('returns 404 for revoked share', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'f4', name: 'revoked.txt' })
      const share = await createShareRepo(db).create({ matterId: 'f4', creatorId, kind: 'landing' })
      await db.run(sql`UPDATE shares SET status = 'revoked' WHERE id = ${share.id}`)

      const res = await app.request(`/api/shares/${share.token}`)
      expect(res.status).toBe(404)
    })

    it('returns requiresPassword=true when password set and no cookie', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'f5', name: 'vault.txt' })
      const share = await createShareRepo(db).create({
        matterId: 'f5',
        creatorId,
        kind: 'landing',
        password: 'correcthorse',
      })

      const res = await app.request(`/api/shares/${share.token}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.requiresPassword).toBe(true)
    })

    it('returns exhausted=true when download limit reached', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'f6', name: 'limited.txt' })
      const share = await createShareRepo(db).create({
        matterId: 'f6',
        creatorId,
        kind: 'landing',
        downloadLimit: 3,
      })
      await db.run(sql`UPDATE shares SET downloads = 3 WHERE id = ${share.id}`)

      const res = await app.request(`/api/shares/${share.token}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.exhausted).toBe(true)
    })
  })

  // ─── POST /api/shares/:token/sessions ────────────────────────────────────────

  describe('POST /api/shares/:token/sessions', () => {
    it('returns 200 and sets cookie on correct password', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'vf1', name: 'vault.txt' })
      const share = await createShareRepo(db).create({
        matterId: 'vf1',
        creatorId,
        kind: 'landing',
        password: 'correcthorse',
      })

      const res = await app.request(`/api/shares/${share.token}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'correcthorse' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      const cookieHeader = res.headers.get('set-cookie')
      expect(cookieHeader).toContain(`sharetk_${share.token}=ok`)
      expect(cookieHeader).toContain('HttpOnly')

      const events = await db.select().from(auditEvents).where(eq(auditEvents.action, 'share_password_passed'))
      expect(events).toHaveLength(0)
    })

    it('returns 403 on wrong password', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'vf2', name: 'vault2.txt' })
      const share = await createShareRepo(db).create({
        matterId: 'vf2',
        creatorId,
        kind: 'landing',
        password: 'correcthorse',
      })

      const res = await app.request(`/api/shares/${share.token}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrongpassword' }),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error: { message: string; status: string } }
      expect(body.error.message).toBe('Invalid password')
      expect(body.error.status).toBe('PERMISSION_DENIED')
      const events = await db.select().from(auditEvents).where(eq(auditEvents.action, 'share_password_passed'))
      expect(events).toHaveLength(0)
    })

    it('returns 404 when verifying a password for an unknown token', async () => {
      const { app } = await createTestApp()
      const res = await app.request('/api/shares/sNoSuchTok01/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'whatever' }),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { message: string; status: string } }
      expect(body.error.message).toBe('Share not found or revoked')
      expect(body.error.status).toBe('NOT_FOUND')
    })

    it('returns 404 when verifying a password for a direct (non-landing) share', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'vf3', name: 'direct-verify.bin' })
      const share = await createShareRepo(db).create({ matterId: 'vf3', creatorId, kind: 'direct' })

      const res = await app.request(`/api/shares/${share.token}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'whatever' }),
      })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { message: string } }
      expect(body.error.message).toBe('Share not found or revoked')
    })
  })

  // ─── GET /api/shares/:token/objects/:ref — root file download ────────────────

  describe('GET /api/shares/:token/objects/:ref — root file', () => {
    it('returns 302 redirect with no-store cache header for public share', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'Dlroot', name: 'photo.jpg' })
      const share = await createShareRepo(db).create({ matterId: 'Dlroot', creatorId, kind: 'landing' })

      const rootRef = await fetchRootRef(app, share.token)
      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(MOCK_PRESIGN_URL)
      expect(res.headers.get('cache-control')).toBe('no-store')

      const rows = await db.all<{ downloads: number }>(sql`SELECT downloads FROM shares WHERE id = ${share.id}`)
      expect(rows[0].downloads).toBe(1)
    })

    it('returns JSON downloadUrl for public share when requested by preview', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'Dlurl1', name: 'report.docx' })
      const share = await createShareRepo(db).create({ matterId: 'Dlurl1', creatorId, kind: 'landing' })

      const rootRef = await fetchRootRef(app, share.token)
      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}?downloadUrl=1`, {
        redirect: 'manual',
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      await expect(res.json()).resolves.toEqual({ downloadUrl: MOCK_PRESIGN_URL })
    })

    it('returns 401 when password required and no cookie', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'Dlpwd', name: 'locked.txt' })
      const share = await createShareRepo(db).create({
        matterId: 'Dlpwd',
        creatorId,
        kind: 'landing',
        password: 'letmein',
      })

      const rootRef = await fetchRootRef(app, share.token)
      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}`, { redirect: 'manual' })
      expect(res.status).toBe(401)
    })

    it('returns 302 when password set and valid cookie provided', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'Dlpwd2', name: 'unlocked.txt' })
      const share = await createShareRepo(db).create({
        matterId: 'Dlpwd2',
        creatorId,
        kind: 'landing',
        password: 'letmein',
      })

      const rootRef = await fetchRootRef(app, share.token)
      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}`, {
        redirect: 'manual',
        headers: { Cookie: `sharetk_${share.token}=ok` },
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(MOCK_PRESIGN_URL)
    })

    it('returns 302 for logged-in recipient without cookie (免密)', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const recipientHeaders = await authedHeaders(app, 'dl-recipient@example.com')
      const recipientId = await getUserIdByEmail(db, 'dl-recipient@example.com')
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'Dlrecip', name: 'for-recipient.txt' })
      const share = await createShareRepo(db).create({
        matterId: 'Dlrecip',
        creatorId,
        kind: 'landing',
        password: 'letmein',
        recipients: [{ recipientUserId: recipientId }],
      })

      const rootRef = await fetchRootRef(app, share.token)
      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}`, {
        redirect: 'manual',
        headers: recipientHeaders,
      })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(MOCK_PRESIGN_URL)
    })

    it('returns 410 when download limit exhausted; counter not incremented past limit', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'dl5', name: 'limited.txt' })
      const share = await createShareRepo(db).create({
        matterId: 'dl5',
        creatorId,
        kind: 'landing',
        downloadLimit: 2,
      })
      await db.run(sql`UPDATE shares SET downloads = 2 WHERE id = ${share.id}`)

      const rootRef = await fetchRootRef(app, share.token)
      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}`, { redirect: 'manual' })
      expect(res.status).toBe(410)

      const rows = await db.all<{ downloads: number }>(sql`SELECT downloads FROM shares WHERE id = ${share.id}`)
      expect(rows[0].downloads).toBe(2)
    })

    it('returns 410 when share is expired', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'dl6', name: 'expired.txt' })
      const pastDate = new Date(Date.now() - 1000)
      const share = await createShareRepo(db).create({
        matterId: 'dl6',
        creatorId,
        kind: 'landing',
        expiresAt: pastDate,
      })

      const rootRef = await fetchRootRef(app, share.token)
      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}`, { redirect: 'manual' })
      expect(res.status).toBe(410)
      const body = (await res.json()) as { error: { message: string } }
      expect(body.error.message).toBe('Share has expired')
    })

    it('returns 410 with AIP-193 body when the shared matter is trashed', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'Dltrash', name: 'gone.txt' })
      // The matter is reachable (status active) when the share is created, then
      // gets trashed — resolveByToken returns matter_trashed for the download.
      const share = await createShareRepo(db).create({ matterId: 'Dltrash', creatorId, kind: 'landing' })
      const rootRef = await fetchRootRef(app, share.token)
      await db.run(sql`UPDATE matters SET trashed_at = ${Date.now()} WHERE id = 'Dltrash'`)

      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}`, { redirect: 'manual' })
      expect(res.status).toBe(410)
      const body = (await res.json()) as { error: { code: number; message: string; status: string } }
      expect(body.error.code).toBe(410)
      expect(body.error.message).toBe('File no longer available')
      expect(body.error.status).toBe('NOT_FOUND')
    })

    it('returns 400 when downloading a folder share root ref directly', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'Dlfolder', name: 'A Folder' })
      const share = await createShareRepo(db).create({ matterId: 'Dlfolder', creatorId, kind: 'landing' })

      const rootRef = await fetchRootRef(app, share.token)
      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}`, { redirect: 'manual' })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { message: string; status: string } }
      expect(body.error.message).toBe('Cannot download a folder directly')
      expect(body.error.status).toBe('INVALID_ARGUMENT')
    })

    it('returns 404 when the shared file references a missing storage', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      // No storage row inserted — the matter points at a storage_id that does
      // not exist, so storage lookup fails after the access gates pass.
      const creatorId = await getFirstUserId(db)
      const now = Date.now()
      await db.run(sql`
        INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, created_at, updated_at)
        VALUES ('Dlnostorage', 'Dlnostoragealias', 'orphan.txt', 'text/plain', 1024, 0, '', 'some/key.txt', 'st-missing', 'active', ${now}, ${now})
      `)
      const share = await createShareRepo(db).create({ matterId: 'Dlnostorage', creatorId, kind: 'landing' })

      const rootRef = await fetchRootRef(app, share.token)
      const res = await app.request(`/api/shares/${share.token}/objects/${rootRef}`, { redirect: 'manual' })
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: { message: string; status: string } }
      expect(body.error.message).toBe('Storage not found')
      expect(body.error.status).toBe('NOT_FOUND')
    })
  })

  // ─── GET /api/shares/:token/readme ──────────────────────────────────────────

  describe('GET /api/shares/:token/readme', () => {
    it('returns the root README.md content without authentication', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'Readmeroot', name: 'Docs' })
      await insertFile(db, { id: 'Readmefile', name: 'README.md', parent: 'Docs' })
      const share = await createShareRepo(db).create({
        matterId: 'Readmeroot',
        creatorId,
        kind: 'landing',
      })
      vi.spyOn(S3Service.prototype, 'getObjectBytes').mockResolvedValue(new TextEncoder().encode('# Shared docs'))

      const res = await app.request(`/api/shares/${share.token}/readme`)

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ content: '# Shared docs' })
    })

    it('returns 404 when the shared folder has no root README.md', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'NoReadmeRoot', name: 'Empty Docs' })
      const share = await createShareRepo(db).create({
        matterId: 'NoReadmeRoot',
        creatorId,
        kind: 'landing',
      })

      const res = await app.request(`/api/shares/${share.token}/readme`)
      expect(res.status).toBe(404)
    })
  })

  // ─── GET /api/shares/:token/objects — list folder children ───────────────────

  describe('GET /api/shares/:token/objects', () => {
    it('returns 404 for an unknown valid token', async () => {
      const { app } = await createTestApp()
      const res = await app.request('/api/shares/sNoSuchTok01/objects')
      expect(res.status).toBe(404)
    })

    it('returns 410 for trashed matter', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'TrashedDir', name: 'Gone', trashedAt: Date.now() })
      const now = Date.now()
      await db.run(sql`
        INSERT INTO shares (id, token, kind, matter_id, creator_id, views, downloads, status, created_at)
        VALUES ('sh-trash-ch', 'sTrashChild1', 'landing', 'TrashedDir', ${creatorId}, 0, 0, 'active', ${now})
      `)

      const res = await app.request('/api/shares/sTrashChild1/objects')
      expect(res.status).toBe(410)
    })

    it('returns 400 for non-folder share', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'ch1', name: 'flat.txt' })
      const share = await createShareRepo(db).create({ matterId: 'ch1', creatorId, kind: 'landing' })

      const res = await app.request(`/api/shares/${share.token}/objects`)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { message: string } }
      expect(body.error.message).toBe('Not a folder share')
    })

    it('returns 410 with AIP-193 body when listing objects of an expired folder share', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'ChExpired', name: 'Expired Folder' })
      const share = await createShareRepo(db).create({
        matterId: 'ChExpired',
        creatorId,
        kind: 'landing',
        expiresAt: new Date(Date.now() - 1000),
      })

      const res = await app.request(`/api/shares/${share.token}/objects`)
      expect(res.status).toBe(410)
      const body = (await res.json()) as { error: { code: number; message: string; status: string } }
      expect(body.error.code).toBe(410)
      expect(body.error.message).toBe('Share has expired')
      expect(body.error.status).toBe('NOT_FOUND')
    })

    it('returns items and breadcrumb for folder share', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'dir1', name: 'Photos' })
      await insertFile(db, { id: 'img1', name: 'cat.jpg', parent: 'Photos' })
      await insertFolder(db, { id: 'dir2', name: 'vacation', parent: 'Photos' })
      const share = await createShareRepo(db).create({ matterId: 'dir1', creatorId, kind: 'landing' })

      const res = await app.request(`/api/shares/${share.token}/objects`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        items: Array<Record<string, unknown>>
        breadcrumb: Array<Record<string, unknown>>
      }
      expect(body.items).toHaveLength(2)
      expect(body.breadcrumb).toEqual([{ name: 'Photos', path: '' }])

      const names = body.items.map((i) => i.name)
      expect(names).toContain('cat.jpg')
      expect(names).toContain('vacation')

      // Each item exposes an opaque ref, not the raw matter id
      expect(body.items.every((i) => typeof i.ref === 'string' && i.ref !== 'img1' && i.ref !== 'dir2')).toBe(true)
    })

    it('returns subfolder contents with breadcrumb when parent= provided', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'root1', name: 'Docs' })
      await insertFolder(db, { id: 'sub1', name: 'Reports', parent: 'Docs' })
      await insertFile(db, { id: 'rpt1', name: 'q1.pdf', parent: 'Docs/Reports' })
      const share = await createShareRepo(db).create({ matterId: 'root1', creatorId, kind: 'landing' })

      const res = await app.request(`/api/shares/${share.token}/objects?parent=Reports`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        items: Array<Record<string, unknown>>
        breadcrumb: Array<Record<string, unknown>>
      }
      expect(body.items).toHaveLength(1)
      expect(body.items[0].name).toBe('q1.pdf')
      expect(body.breadcrumb).toEqual([
        { name: 'Docs', path: '' },
        { name: 'Reports', path: 'Reports' },
      ])
    })

    it('returns 401 for password-protected share without cookie', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'PwDir', name: 'Locked' })
      const share = await createShareRepo(db).create({
        matterId: 'PwDir',
        creatorId,
        kind: 'landing',
        password: 'letmein',
      })

      const res = await app.request(`/api/shares/${share.token}/objects`)
      expect(res.status).toBe(401)
    })

    it('returns 400 when parent contains traversal segments', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'TraversalDir', name: 'Safe' })
      const share = await createShareRepo(db).create({ matterId: 'TraversalDir', creatorId, kind: 'landing' })

      const res = await app.request(`/api/shares/${share.token}/objects?parent=../etc`)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { message: string } }
      expect(body.error.message).toBe('Invalid path')
    })

    it('continues a folder listing with an opaque page token', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'Pgdir', name: 'Paged' })
      await insertFile(db, { id: 'Pg1', name: 'a.txt', parent: 'Paged' })
      await insertFile(db, { id: 'Pg2', name: 'b.txt', parent: 'Paged' })
      await insertFile(db, { id: 'Pg3', name: 'c.txt', parent: 'Paged' })
      const share = await createShareRepo(db).create({ matterId: 'Pgdir', creatorId, kind: 'landing' })

      const first = await app.request(`/api/shares/${share.token}/objects?pageSize=2`)
      expect(first.status).toBe(200)
      const firstBody = (await first.json()) as {
        items: Array<{ name: string }>
        nextPageToken: string | null
      }
      expect(firstBody.items.map((item) => item.name)).toEqual(['a.txt', 'b.txt'])
      expect(firstBody.nextPageToken).toEqual(expect.any(String))

      const second = await app.request(
        `/api/shares/${share.token}/objects?pageSize=2&pageToken=${encodeURIComponent(firstBody.nextPageToken!)}`,
      )
      expect(second.status).toBe(200)
      const secondBody = (await second.json()) as {
        items: Array<{ name: string }>
        nextPageToken: string | null
      }
      expect(secondBody.items.map((item) => item.name)).toEqual(['c.txt'])
      expect(secondBody.nextPageToken).toBeNull()
    })

    it('rejects an invalid page size', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'NanDir', name: 'NaN' })
      const share = await createShareRepo(db).create({ matterId: 'NanDir', creatorId, kind: 'landing' })

      const res = await app.request(`/api/shares/${share.token}/objects?pageSize=xyz`)
      expect(res.status).toBe(400)
    })
  })

  // ─── GET /api/shares/:token/objects/:ref — descendant ref ────────────────────

  describe('GET /api/shares/:token/objects/:ref — descendant', () => {
    it('redirects for valid descendant ref', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'fld1', name: 'Archive' })
      await insertFile(db, { id: 'arc1', name: 'old.zip', parent: 'Archive' })
      const share = await createShareRepo(db).create({ matterId: 'fld1', creatorId, kind: 'landing' })

      const childrenRes = await app.request(`/api/shares/${share.token}/objects`)
      const childrenBody = (await childrenRes.json()) as { items: Array<{ ref: string }> }
      const ref = childrenBody.items[0].ref

      const res = await app.request(`/api/shares/${share.token}/objects/${ref}`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(MOCK_PRESIGN_URL)
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('returns 400 for invalid/forged ref', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'fld2', name: 'Safe' })
      const share = await createShareRepo(db).create({ matterId: 'fld2', creatorId, kind: 'landing' })

      const res = await app.request(`/api/shares/${share.token}/objects/invalid-ref`, { redirect: 'manual' })
      expect(res.status).toBe(400)
    })

    it('returns 404 when ref decodes to a matter outside the folder subtree', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFolder(db, { id: 'fld3', name: 'Folder3' })
      await insertFile(db, { id: 'out1', name: 'outside.txt' })
      const share = await createShareRepo(db).create({ matterId: 'fld3', creatorId, kind: 'landing' })

      const { createHmac } = await import('node:crypto')
      const sig = createHmac('sha256', share.token).update('out1').digest('hex').slice(0, 16)
      const fakeRef = Buffer.from(`out1.${sig}`).toString('base64url')

      const res = await app.request(`/api/shares/${share.token}/objects/${fakeRef}`, { redirect: 'manual' })
      expect(res.status).toBe(404)
    })
  })

  // ─── GET /r/:token — unified redirect for direct shares ────────────────────

  describe('GET /r/:token (direct shares)', () => {
    it('returns 302 redirect for valid direct share', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'dlx1', name: 'direct.bin' })
      const share = await createShareRepo(db).create({ matterId: 'dlx1', creatorId, kind: 'direct' })

      const res = await app.request(`/r/${share.token}`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(MOCK_PRESIGN_URL)
      expect(res.headers.get('cache-control')).toContain('no-store')
    })

    it('returns 404 for landing share token at /r/', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'dlx2', name: 'landing.txt' })
      const share = await createShareRepo(db).create({ matterId: 'dlx2', creatorId, kind: 'landing' })

      const res = await app.request(`/r/${share.token}`, { redirect: 'manual' })
      expect(res.status).toBe(404)
    })

    it('returns 404 for an unknown token', async () => {
      const { app } = await createTestApp()
      const res = await app.request('/r/nosuchthing', { redirect: 'manual' })
      expect(res.status).toBe(404)
    })

    it('returns 410 for trashed matter', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'dlx3', name: 'trashed.txt', trashedAt: Date.now() })
      const now = Date.now()
      await db.run(sql`
        INSERT INTO shares (id, token, kind, matter_id, creator_id, views, downloads, status, created_at)
        VALUES ('shdltrash', 'sDirectTrash', 'direct', 'dlx3', ${creatorId}, 0, 0, 'active', ${now})
      `)

      const res = await app.request('/r/sDirectTrash', { redirect: 'manual' })
      expect(res.status).toBe(410)
    })

    it('returns 410 when limit exhausted', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'dlx4', name: 'limited.bin' })
      const share = await createShareRepo(db).create({
        matterId: 'dlx4',
        creatorId,
        kind: 'direct',
        downloadLimit: 1,
      })
      await db.run(sql`UPDATE shares SET downloads = 1 WHERE id = ${share.id}`)

      const res = await app.request(`/r/${share.token}`, { redirect: 'manual' })
      expect(res.status).toBe(410)
    })

    it('does not require auth (verified: no auth header needed)', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'dlx5', name: 'public.bin' })
      const share = await createShareRepo(db).create({ matterId: 'dlx5', creatorId, kind: 'direct' })

      const res = await app.request(`/r/${share.token}`, { redirect: 'manual' })
      expect(res.status).toBe(302)
    })
  })

  // ─── No auth required on public share routes ─────────────────────────────────

  describe('public routes require no auth', () => {
    it('GET /api/shares/:token succeeds without any auth headers', async () => {
      const { app, db } = await createTestApp()
      await authedHeaders(app)
      await insertStorage(db)
      const creatorId = await getFirstUserId(db)
      await insertFile(db, { id: 'pub1', name: 'open.txt' })
      const share = await createShareRepo(db).create({ matterId: 'pub1', creatorId, kind: 'landing' })

      const res = await app.request(`/api/shares/${share.token}`)
      expect(res.status).toBe(200)
    })
  })
})
