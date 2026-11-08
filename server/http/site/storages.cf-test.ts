import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createStorageRepo } from '../../adapters/repos/storage'
import { createApp } from '../../app'
import { createAuth } from '../../auth'
import { createCloudflarePlatform } from '../../platform/cloudflare'

const ADMIN_EMAIL = 'cf-admin@example.com'
const ADMIN_PASSWORD = 'password123456'
const ADMIN_NAME = 'CF Test'

async function buildApp() {
  const platform = createCloudflarePlatform(env)
  const auth = await createAuth(platform.db, env.BETTER_AUTH_SECRET, 'http://localhost')
  return createApp(platform, auth)
}

// Single-admin instances only allow the very first account to self-register.
// Every other test signs in as that same admin (the first account is admin).
async function adminHeaders(app: ReturnType<typeof buildApp>) {
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
  return { Cookie: cookies.join('; ') }
}

const validStorage = {
  bucket: 'cf-test-bucket',
  endpoint: 'https://s3.amazonaws.com',
  region: 'us-east-1',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}

const validReplacement = {
  provider: '',
  ...validStorage,
  capacity: 0,
  forcePathStyle: true,
  enabled: true,
}

describe('[CF] Admin Storages API', () => {
  it('returns 401 without auth [spec: storages/auth-required]', async () => {
    const app = await buildApp()
    const res = await app.request('/api/site/storages')
    expect(res.status).toBe(401)
  })

  it('GET /api/site/storages returns empty list [spec: storages/list]', async () => {
    const app = await buildApp()
    const headers = await adminHeaders(app)
    const res = await app.request('/api/site/storages', { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; total: number }
    expect(body).toEqual({ items: [], total: 0, page: 1, pageSize: 0 })
  })

  it('POST /api/site/storages creates a storage [spec: storages/create]', async () => {
    const app = await buildApp()
    const headers = await adminHeaders(app)
    const res = await app.request('/api/site/storages', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validStorage,
        bucket: `cf-test-bucket-${Date.now()}`,
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.enabled).toBe(true)
    expect(body.status).toBe('unknown')
    expect(body.statusReason).toBeNull()
    expect(body.id).toBeTruthy()
  })

  it('GET /api/site/storages/:id returns storage detail [spec: storages/detail]', async () => {
    const app = await buildApp()
    const headers = await adminHeaders(app)
    const platform = createCloudflarePlatform(env)
    const created = await createStorageRepo(platform.db).create({
      ...validStorage,
      title: `CF Detail ${Date.now()}`,
      bucket: `cf-detail-${Date.now()}`,
    })

    const res = await app.request(`/api/site/storages/${created.id}`, { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe(created.id)
  })

  it('PUT /api/site/storages/:id updates a storage [spec: storages/update]', async () => {
    const app = await buildApp()
    const headers = await adminHeaders(app)
    const platform = createCloudflarePlatform(env)
    const created = await createStorageRepo(platform.db).create({
      ...validStorage,
      bucket: `cf-update-${Date.now()}`,
    })

    const res = await app.request(`/api/site/storages/${created.id}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validReplacement, bucket: 'updated-cf-bucket' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.bucket).toBe('updated-cf-bucket')
  })

  it('DELETE /api/site/storages/:id deletes a storage [spec: storages/delete]', async () => {
    const app = await buildApp()
    const headers = await adminHeaders(app)
    const platform = createCloudflarePlatform(env)
    const created = await createStorageRepo(platform.db).create({
      ...validStorage,
      title: `CF Delete ${Date.now()}`,
      bucket: `cf-delete-${Date.now()}`,
    })

    const res = await app.request(`/api/site/storages/${created.id}`, {
      method: 'DELETE',
      headers,
    })
    expect(res.status).toBe(204)
  })
})
