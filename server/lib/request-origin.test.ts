import { describe, expect, it } from 'vitest'
import { createDynamicTrustedOrigins, publicRequestOrigin } from './request-origin'

const ORIGIN_HOST = 'https://zpan-origin.workers.dev'
const CDN_ORIGIN = 'https://zpan.digpat.com'

function proxiedRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN_HOST}/api/auth/sign-in/email`, { method: 'POST', headers })
}

describe('publicRequestOrigin', () => {
  it('falls back to the origin-side URL when no proxy headers are present', () => {
    expect(publicRequestOrigin(proxiedRequest())).toBe(ORIGIN_HOST)
  })

  it('uses x-forwarded-host / x-forwarded-proto from a CDN', () => {
    const request = proxiedRequest({
      Host: 'zpan-origin.workers.dev',
      'X-Forwarded-Host': 'zpan.digpat.com',
      'X-Forwarded-Proto': 'https',
    })
    expect(publicRequestOrigin(request)).toBe(CDN_ORIGIN)
  })

  it('takes the first value from comma-separated proxy headers', () => {
    const request = proxiedRequest({
      'X-Forwarded-Host': 'zpan.digpat.com, zpan-origin.workers.dev',
      'X-Forwarded-Proto': 'https, http',
    })
    expect(publicRequestOrigin(request)).toBe(CDN_ORIGIN)
  })

  it('supports RFC 7239 Forwarded headers', () => {
    const request = proxiedRequest({
      Forwarded: 'for=192.0.2.1;proto=https;host=zpan.digpat.com',
    })
    expect(publicRequestOrigin(request)).toBe(CDN_ORIGIN)
  })

  it('supports the Cloudflare cf-visitor scheme', () => {
    const request = proxiedRequest({
      'X-Forwarded-Host': 'zpan.digpat.com',
      'CF-Visitor': '{"scheme":"https"}',
    })
    expect(publicRequestOrigin(request)).toBe(CDN_ORIGIN)
  })

  it('rejects malformed host headers instead of trusting an injected URL', () => {
    expect(publicRequestOrigin(proxiedRequest({ 'X-Forwarded-Host': 'evil.example/@zpan.digpat.com' }))).toBe(
      ORIGIN_HOST,
    )
    expect(publicRequestOrigin(proxiedRequest({ 'X-Forwarded-Proto': 'javascript' }))).toBe(`${ORIGIN_HOST}`)
  })
})

describe('createDynamicTrustedOrigins', () => {
  it('normalizes and deduplicates static origins, including URLs with paths', () => {
    const resolve = createDynamicTrustedOrigins([`${CDN_ORIGIN}/api/auth`, CDN_ORIGIN, '', 'not a url'])
    expect(resolve()).toEqual([CDN_ORIGIN])
  })

  it('adds the public origin of each request so any CDN hostname is trusted', () => {
    const resolve = createDynamicTrustedOrigins(['http://localhost:3000'])
    const first = proxiedRequest({
      'X-Forwarded-Host': 'zpan.digpat.com',
      'X-Forwarded-Proto': 'https',
    })
    const second = proxiedRequest({
      'X-Forwarded-Host': 'pan.other-cdn.example',
      'X-Forwarded-Proto': 'https',
    })

    expect(resolve(first)).toEqual(['http://localhost:3000', CDN_ORIGIN, ORIGIN_HOST])
    expect(resolve(second)).toEqual(['http://localhost:3000', 'https://pan.other-cdn.example', ORIGIN_HOST])
  })

  it('trusts the browser Origin header when the proxy hides the public host', () => {
    const resolve = createDynamicTrustedOrigins([])
    const request = proxiedRequest({ Origin: CDN_ORIGIN })
    expect(resolve(request)).toContain(CDN_ORIGIN)
  })

  it('can disable the Origin-header fallback', () => {
    const resolve = createDynamicTrustedOrigins([], { trustRequestOrigin: false })
    const request = proxiedRequest({ Origin: CDN_ORIGIN })
    expect(resolve(request)).not.toContain(CDN_ORIGIN)
  })
})
