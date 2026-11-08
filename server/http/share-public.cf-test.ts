import { env } from 'cloudflare:workers'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createShareRepo } from '../adapters/repos/share'
import { createApp } from '../app'
import { createAuth } from '../auth'
import { createCloudflarePlatform } from '../platform/cloudflare'

// ─── CF routing regression guard ─────────────────────────────────────────────
// Verifies that public share JSON endpoints live under /api/* (Worker-handled)
// and NOT under /s/* (CF Assets serves the SPA there).
describe('[CF] Routing regression — share routes must be under /api/* or /r/*', () => {
  it('/s/:token returns 404 (not routed) — JSON share API is not mounted at /s', async () => {
    const platform = createCloudflarePlatform(env)
    const auth = await createAuth(platform.db, env.BETTER_AUTH_SECRET, 'http://localhost')
    const app = createApp(platform, auth)

    const res = await app.request('/s/any-token')
    expect(res.status).toBe(404)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).not.toContain('application/json')
  })

  it('/api/shares/:token returns JSON (not SPA) — correct path for share API', async () => {
    const platform = createCloudflarePlatform(env)
    const auth = await createAuth(platform.db, env.BETTER_AUTH_SECRET, 'http://localhost')
    const app = createApp(platform, auth)

    const res = await app.request('/api/shares/sNotFound001')
    expect(res.status).toBe(404)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).toContain('application/json')
  })
})

const STORAGE_ID = 'st-cf-share'
const ADMIN_EMAIL = 'cf-admin@example.com'
const ADMIN_PASSWORD = 'password123456'
const ADMIN_NAME = 'CF Test'

async function buildApp() {
  const platform = createCloudflarePlatform(env)
  const auth = await createAuth(platform.db, env.BETTER_AUTH_SECRET, 'http://localhost')
  return { app: createApp(platform, auth), db: platform.db }
}

// Single-admin instances only allow the very first account to self-register.
// Every other test signs in as that same admin.
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

async function insertFile(
  db: Awaited<ReturnType<typeof buildApp>>['db'],
  opts: { id: string; name: string; parent?: string },
) {
  const now = Date.now()
  await db.run(sql`
    INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, created_at, updated_at)
    VALUES (${opts.id}, ${`${opts.id}-cf-alias`}, ${opts.name}, 'text/plain', 512, 0, ${opts.parent ?? ''}, 'keys/file.txt', ${STORAGE_ID}, 'active', ${now}, ${now})
  `)
}

async function insertFolder(db: Awaited<ReturnType<typeof buildApp>>['db'], opts: { id: string; name: string }) {
  const now = Date.now()
  await db.run(sql`
    INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, created_at, updated_at)
    VALUES (${opts.id}, ${`${opts.id}-cf-alias`}, ${opts.name}, 'folder', 0, 1, '', '', ${STORAGE_ID}, 'active', ${now}, ${now})
  `)
}

describe('[CF] Public share routes — no session authorization', () => {
  it('GET /api/shares/:token returns share metadata without auth', async () => {
    const { app, db } = await buildApp()
    const { userId } = await signUpAndGetIds(app, db)
    await insertStorage(db)
    await insertFile(db, { id: `cf-f1-${Date.now()}`, name: 'cf-file.txt' })

    const rows = await db.all<{ id: string }>(sql`SELECT id FROM matters WHERE name = 'cf-file.txt' LIMIT 1`)
    const matterId = rows[0].id
    const share = await createShareRepo(db).create({ matterId, creatorId: userId, kind: 'landing' })

    const res = await app.request(`/api/shares/${share.token}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.kind).toBe('landing')
    expect(body.creatorName).toBe('CF Test')
    const matter = body.matter as Record<string, unknown>
    expect(matter.name).toBe('cf-file.txt')
  })

  it('GET /api/shares/:token/readme is available without auth', async () => {
    const { app, db } = await buildApp()
    const { userId } = await signUpAndGetIds(app, db)
    await insertStorage(db)
    const folderId = `cf-readme-folder-${Date.now()}`
    await insertFolder(db, { id: folderId, name: 'Docs' })
    const share = await createShareRepo(db).create({ matterId: folderId, creatorId: userId, kind: 'landing' })

    const res = await app.request(`/api/shares/${share.token}/readme`)

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: { message: 'README.md not found' } })
  })

  it('GET /r/unknown-prefix returns 404 for unknown token without auth', async () => {
    const { app } = await buildApp()
    const res = await app.request('/r/nonexistent-cf-token')
    expect(res.status).toBe(404)
  })
})

describe('[CF] Concurrent downloads — atomic limit enforcement', () => {
  it('with limit=5 and 20 concurrent requests, exactly 5 succeed', async () => {
    const { app, db } = await buildApp()
    const { userId } = await signUpAndGetIds(app, db)
    await insertStorage(db)
    const fileId = `cf-dlc-${Date.now()}`
    await insertFile(db, { id: fileId, name: 'concurrent.bin' })

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
