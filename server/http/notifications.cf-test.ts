import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { createAuth } from '../auth'
import { createCloudflarePlatform } from '../platform/cloudflare'

const ADMIN_EMAIL = 'cf-admin@example.com'
const ADMIN_PASSWORD = 'password123456'
const ADMIN_NAME = 'CF Test'

async function buildApp() {
  const platform = createCloudflarePlatform(env)
  const auth = await createAuth(platform.db, env.BETTER_AUTH_SECRET, 'http://localhost')
  return createApp(platform, auth)
}

// Single-admin instances only allow the very first account to self-register.
// Every other test signs in as that same admin to get a real Better Auth session.
async function authedHeaders(app: ReturnType<typeof buildApp>) {
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

describe('[CF] Notifications API', () => {
  it('returns 401 without auth', async () => {
    const app = await buildApp()
    const res = await app.request('/api/notifications')
    expect(res.status).toBe(401)
  })

  it('GET /api/notifications returns empty list', async () => {
    const app = await buildApp()
    const headers = await authedHeaders(app)
    const res = await app.request('/api/notifications', { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; nextPageToken: string | null }
    expect(body.items).toHaveLength(0)
    expect(body.nextPageToken).toBeNull()
  })

  it('GET /api/notifications/stats returns 0', async () => {
    const app = await buildApp()
    const headers = await authedHeaders(app)
    const res = await app.request('/api/notifications/stats', { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number }
    expect(body.count).toBe(0)
  })

  it('PATCH /api/notifications returns count 0 when empty', async () => {
    const app = await buildApp()
    const headers = await authedHeaders(app)
    const res = await app.request('/api/notifications', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number }
    expect(body.count).toBe(0)
  })

  it('PATCH /api/notifications/nonexistent returns 404', async () => {
    const app = await buildApp()
    const headers = await authedHeaders(app)
    const res = await app.request('/api/notifications/nonexistent', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: true }),
    })
    expect(res.status).toBe(404)
  })
})
