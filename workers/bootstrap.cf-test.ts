import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from './bootstrap'

const testEnv = { ...env }

const fakeSpaHtml = '<html><head><title>ZPan</title></head><body></body></html>'
const fakeAssets = {
  fetch: (_req: RequestInfo | Request) =>
    Promise.resolve(new Response(fakeSpaHtml, { status: 200, headers: { 'Content-Type': 'text/html' } })),
} as unknown as Fetcher

describe('[CF] Worker fetch handler', () => {
  it('answers with setup guidance when neither an explicit secret nor admin credentials are configured', async () => {
    const envWithoutCredentials = {
      ...env,
      BETTER_AUTH_SECRET: '',
      ZPAN_USERNAME: '',
      ZPAN_PASSWORD: '',
    }
    const res = await worker.fetch(new Request('http://localhost/api/health'), envWithoutCredentials)
    expect(res.status).toBe(503)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = (await res.json()) as { error: string; message: string; hint: string }
    expect(body.error).toBe('instance_not_configured')
    expect(body.message).toContain('ZPAN_USERNAME and ZPAN_PASSWORD are required to derive BETTER_AUTH_SECRET')
    expect(body.hint).toContain('ZPAN_PASSWORD')

    const page = await worker.fetch(new Request('http://localhost/'), envWithoutCredentials)
    expect(page.status).toBe(503)
    expect(page.headers.get('Content-Type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('ZPan needs initial configuration')
    expect(html).toContain('ZPAN_PASSWORD')
  })

  it('derives the signing secret from ZPAN_USERNAME / ZPAN_PASSWORD', async () => {
    // Preview slot forces a fresh app initialization even though the isolate
    // already cached an app built with the explicit test secret.
    const derivedEnv = { ...env, BETTER_AUTH_SECRET: undefined, ZPAN_PREVIEW: 'true' }
    const res = await worker.fetch(new Request('https://derived-secret.example.com/api/health'), derivedEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('returns a response for a valid request', async () => {
    const request = new Request('http://localhost/api/health')
    const res = await worker.fetch(request, testEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('publishes the Arazzo workflow description from the Worker runtime', async () => {
    const root = await worker.fetch(new Request('https://pan.example.com/api'), testEnv)
    const workflow = await worker.fetch(new Request('https://pan.example.com/api/workflows.arazzo.json'), testEnv)

    expect(root.status).toBe(200)
    expect(root.headers.get('Link')).toContain(
      '</api/workflows.arazzo.json>; rel="describedby"; type="application/vnd.oai.workflows+json"',
    )
    expect(workflow.status).toBe(200)
    expect(workflow.headers.get('Content-Type')).toBe('application/vnd.oai.workflows+json; version=1.1.0')
    expect(await workflow.json()).toMatchObject({
      arazzo: '1.1.0',
      $self: 'https://pan.example.com/api/workflows.arazzo.json',
      sourceDescriptions: [{ url: './openapi.json', type: 'openapi' }],
    })
  })

  it('splits and trims TRUSTED_ORIGINS when provided', async () => {
    const request = new Request('http://localhost/api/health')
    const envWithOrigins = { ...testEnv, TRUSTED_ORIGINS: ' https://a.example.com , https://b.example.com ' }
    const res = await worker.fetch(request, envWithOrigins)
    expect(res.status).toBe(200)
  })

  it('routes the WebDAV mount root with and without trailing slash', async () => {
    for (const path of ['/dav', '/dav/']) {
      const res = await worker.fetch(new Request(`http://localhost${path}`, { method: 'PROPFIND' }), testEnv)
      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="ZPan WebDAV"')
    }
  })

  it('keeps auth initialization isolated between the DAV and primary hostnames', async () => {
    const dav = await worker.fetch(new Request('https://dav.example.com/dav/', { method: 'PROPFIND' }), testEnv)
    expect(dav.status).toBe(401)

    const primary = await worker.fetch(new Request('https://pan.example.com/api/health'), testEnv)
    expect(primary.status).toBe(200)
  })

  it('serves public config from the Worker response cache after the first request', async () => {
    const request = new Request('https://cache-test.example.com/api/configz')
    const firstCtx = createExecutionContext()
    const first = await worker.fetch(request, testEnv, firstCtx)
    await waitOnExecutionContext(firstCtx)

    expect(first.status).toBe(200)
    expect(first.headers.get('x-zpan-cache')).not.toBe('edge')

    const secondCtx = createExecutionContext()
    const second = await worker.fetch(request, testEnv, secondCtx)
    await waitOnExecutionContext(secondCtx)

    expect(second.status).toBe(200)
    expect(second.headers.get('x-zpan-cache')).toBe('edge')
  })
})

describe('[CF] SSR share OG meta injection', () => {
  it('injects real file name into og:title for valid landing share', async () => {
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO matters (id, alias, name, type, size, dirtype, parent, object, storage_id, status, created_at, updated_at)
       VALUES ('ssrmatter1', 'ssralias1', 'design-spec.pdf', 'application/pdf', 4096, 0, '', 'obj/key.pdf', 'st1', 'active', ?, ?)`,
    )
      .bind(now, now)
      .run()

    await env.DB.prepare(
      `INSERT INTO shares (id, token, kind, matter_id, creator_id, password_hash, expires_at, download_limit, views, downloads, status, created_at)
       VALUES ('ssrshare1', 'ssrtoken01', 'landing', 'ssrmatter1', 'user1', NULL, NULL, NULL, 0, 0, 'active', ?)`,
    )
      .bind(now)
      .run()

    const testEnvWithAssets = { ...testEnv, ASSETS: fakeAssets }
    const res = await worker.fetch(new Request('http://localhost/s/ssrtoken01'), testEnvWithAssets)

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<meta property="og:title" content="design-spec.pdf"')
    expect(html).not.toContain('Share unavailable')
  })

  it('returns fallback OG meta for unknown share token', async () => {
    const testEnvWithAssets = { ...testEnv, ASSETS: fakeAssets }
    const res = await worker.fetch(new Request('http://localhost/s/no-such-token'), testEnvWithAssets)

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<meta property="og:title" content="Share unavailable"')
  })
})
