import { describe, expect, it } from 'vitest'
import { createDynamicTrustedOrigins } from './lib/request-origin'
import { authedHeaders, createTestApp } from './test/setup.js'

const CDN_ORIGIN = 'https://zpan.digpat.com'
const PASSWORD = 'password123456'
const SIGN_IN_PATH = '/api/auth/sign-in/email'

function proxiedSignIn(app: Awaited<ReturnType<typeof createTestApp>>['app'], body: object, headers: object) {
  return app.request(SIGN_IN_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'admin@example.com', password: PASSWORD, ...body }),
  })
}

describe('sign-in through an arbitrary CDN hostname', () => {
  it('accepts an absolute callbackURL on the proxied public hostname', async () => {
    const { app } = await createTestApp({}, {}, undefined, createDynamicTrustedOrigins(['http://localhost:3000']))
    await authedHeaders(app, 'admin@example.com', PASSWORD)

    const callbackURL = `${CDN_ORIGIN}/%2F`
    const res = await proxiedSignIn(
      app,
      { callbackURL },
      {
        Origin: CDN_ORIGIN,
        'X-Forwarded-Host': 'zpan.digpat.com',
        'X-Forwarded-Proto': 'https',
      },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Location')).toBe(callbackURL)
    expect(await res.json()).toMatchObject({ redirect: true, url: callbackURL })
  })

  it('still works when the proxy hides the public host behind an Origin header', async () => {
    const { app } = await createTestApp({}, {}, undefined, createDynamicTrustedOrigins(['http://localhost:3000']))
    await authedHeaders(app, 'admin@example.com', PASSWORD)

    const res = await proxiedSignIn(app, { callbackURL: `${CDN_ORIGIN}/files` }, { Origin: CDN_ORIGIN })

    expect(res.status).toBe(200)
    expect(res.headers.get('Location')).toBe(`${CDN_ORIGIN}/files`)
  })

  it('rejects a callbackURL on an unrelated host', async () => {
    const { app } = await createTestApp({}, {}, undefined, createDynamicTrustedOrigins(['http://localhost:3000']))
    await authedHeaders(app, 'admin@example.com', PASSWORD)

    const res = await proxiedSignIn(
      app,
      { callbackURL: 'https://evil.example/files' },
      {
        Origin: CDN_ORIGIN,
        'X-Forwarded-Host': 'zpan.digpat.com',
        'X-Forwarded-Proto': 'https',
      },
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'INVALID_CALLBACK_URL' })
  })
})
