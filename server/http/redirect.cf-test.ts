import { env } from 'cloudflare:workers'
import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { S3Service } from '../adapters/gateways/s3'
import { createShareRepo } from '../adapters/repos/share'
import { createApp } from '../app'
import { createAuth } from '../auth'
import { createCloudflarePlatform } from '../platform/cloudflare'

const STORAGE_ID = 'st-cf-redirect'
const MOCK_PRESIGN_URL = 'https://presigned-cf.example.com/file'
const ADMIN_EMAIL = 'cf-admin@example.com'
const ADMIN_PASSWORD = 'password123456'
const ADMIN_NAME = 'CF Test'

async function buildApp() {
  const platform = createCloudflarePlatform(env)
  const auth = await createAuth(platform.db, env.BETTER_AUTH_SECRET, 'http://localhost')
  return { app: createApp(platform, auth), db: platform.db }
}

// Single-admin instances only allow the very first account to self-register.
// Every other test signs in as that same admin; organization tables no longer
// exist, so only the (single) user id is returned.
async function signUpAndGetIds(app: ReturnType<typeof createApp>, db: Awaited<ReturnType<typeof buildApp>>['db']) {
  const signUpRes = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: ADMIN_NAME, email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  const res = signUpRes.ok
    ? signUpRes
    : await app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      })
  const cookies = res.headers.getSetCookie().map((cookie) => cookie.split(';')[0])
  if (cookies.length === 0) throw new Error('auth response carried no session cookie')
  const userRows = await db.all<{ id: string }>(sql`SELECT id FROM user WHERE email = ${ADMIN_EMAIL} LIMIT 1`)
  return { headers: { Cookie: cookies.join('; ') }, userId: userRows[0].id }
}

async function insertStorage(db: Awaited<ReturnType<typeof buildApp>>['db']) {
  const now = Date.now()
  await db.run(sql`
    INSERT OR IGNORE INTO storages (id, bucket, endpoint, region, access_key, secret_key, file_path, capacity, used, status, created_at, updated_at)
    VALUES (${STORAGE_ID}, 'cf-bucket', 'https://s3.amazonaws.com', 'us-east-1', 'AK', 'SK', '', 0, 0, 'active', ${now}, ${now})
  `)
}

async function insertFile(db: Awaited<ReturnType<typeof buildApp>>['db'], opts: { id: string; name: string }) {
  const now = Date.now()
  await db.run(sql`
    INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, created_at, updated_at)
    VALUES (${opts.id}, ${`${opts.id}-cf-alias`}, ${opts.name}, 'image/png', 512, 0, '', 'keys/file.png', ${STORAGE_ID}, 'active', ${now}, ${now})
  `)
}

// ─── CF routing guard ─────────────────────────────────────────────────────────

describe('[CF] /r/* routing — Worker handles these paths', () => {
  it('/r/:token with unknown prefix returns 404 (Worker-handled, not CF Assets) [spec: redirect/unknown-ds-token]', async () => {
    const { app } = await buildApp()
    const res = await app.request('/r/unknownprefix_token')
    expect(res.status).toBe(404)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).toContain('application/json')
  })

  it('/dl/* is NOT routed (returns 404 — old path removed)', async () => {
    const { app } = await buildApp()
    const res = await app.request('/dl/any-token')
    expect(res.status).toBe(404)
  })
})

// ─── CF direct share tests ────────────────────────────────────────────────────

describe('[CF] /r/:token direct shares', () => {
  it('returns 302 for valid direct share [spec: redirect/direct-share]', async () => {
    vi.spyOn(S3Service.prototype, 'presignDownload').mockResolvedValue(MOCK_PRESIGN_URL)
    const { app, db } = await buildApp()
    const { userId } = await signUpAndGetIds(app, db)
    await insertStorage(db)
    await insertFile(db, { id: `cf-ds-${Date.now()}`, name: 'cf-direct.bin' })

    const rows = await db.all<{ id: string }>(sql`SELECT id FROM matters WHERE name = 'cf-direct.bin' LIMIT 1`)
    const matterId = rows[0].id
    const share = await createShareRepo(db).create({ matterId, creatorId: userId, kind: 'direct' })

    const res = await app.request(`/r/${share.token}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('cache-control')).toContain('no-store')
    vi.restoreAllMocks()
  })
})

// ─── CF concurrent downloads — atomic limit enforcement ───────────────────────

describe('[CF] Concurrent downloads — atomic limit enforcement via /r/', () => {
  it('with limit=5 and 20 concurrent requests, exactly 5 succeed', async () => {
    const { app, db } = await buildApp()
    const { userId } = await signUpAndGetIds(app, db)
    await insertStorage(db)
    const fileId = `cf-dlc-r-${Date.now()}`
    await insertFile(db, { id: fileId, name: 'concurrent-r.bin' })

    const share = await createShareRepo(db).create({
      matterId: fileId,
      creatorId: userId,
      kind: 'direct',
      downloadLimit: 5,
    })

    const results = await Promise.all(
      Array.from({ length: 20 }, () => app.request(`/r/${share.token}`, { redirect: 'manual' }).then((r) => r.status)),
    )

    const passed = results.filter((s) => s !== 410).length
    const rejected = results.filter((s) => s === 410).length

    expect(passed).toBe(5)
    expect(rejected).toBe(15)
  })
})
