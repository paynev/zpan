import { describe, expect, it } from 'vitest'
import { deriveAuthSecret } from '../../shared/auth-secret'
import type { Platform } from '../platform/interface'
import {
  createdAtIdCursorCodec,
  decodeOptionalPageToken,
  decodePageToken,
  directoryCursorCodec,
  encodeNextPageToken,
  encodePageToken,
  pageQueryFingerprint,
  trashCursorCodec,
} from './page-token'

const username = 'page-token@example.com'
const password = 'test-password'

// Mirrors production: no explicit BETTER_AUTH_SECRET, so page tokens are
// signed with the key derived from the admin credentials.
function platform(secretPassword: string = password): Platform {
  return {
    db: {} as Platform['db'],
    getBinding: () => undefined,
    getEnv: (key) => (key === 'ZPAN_USERNAME' ? username : key === 'ZPAN_PASSWORD' ? secretPassword : undefined),
  }
}

async function signRawBody(body: string, secret: string): Promise<string> {
  const encodedBody = Buffer.from(body).toString('base64url')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`zpan:page-token:v1:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedBody))
  return `${encodedBody}.${Buffer.from(signature).toString('base64url')}`
}

describe('page tokens', () => {
  it('round-trips a signed boundary', async () => {
    const query = await pageQueryFingerprint({ status: 'active', sort: ['createdAt', 'desc'] })
    const token = await encodePageToken(platform(), {
      boundary: { createdAt: 123, id: 'item-1' },
      query,
      now: 1_000,
    })

    await expect(decodePageToken(platform(), token, { query, now: 2_000 })).resolves.toEqual({
      createdAt: 123,
      id: 'item-1',
    })
  })

  it('rejects tampering, query mismatches, and expired tokens', async () => {
    const query = await pageQueryFingerprint({ status: 'active' })
    const token = await encodePageToken(platform(), {
      boundary: { id: 'item-1' },
      query,
      now: 1_000,
    })

    await expect(decodePageToken(platform(), `${token}x`, { query, now: 2_000 })).rejects.toMatchObject({
      httpStatus: 400,
      meta: { reason: 'INVALID_PAGE_TOKEN' },
    })
    await expect(decodePageToken(platform(), token, { query: 'different', now: 2_000 })).rejects.toMatchObject({
      httpStatus: 400,
      meta: { reason: 'INVALID_PAGE_TOKEN' },
    })
    await expect(
      decodePageToken(platform(), token, { query, now: 1_000 + 72 * 60 * 60 * 1_000 }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      meta: { reason: 'INVALID_PAGE_TOKEN' },
    })
  })

  it.each([
    {
      codec: createdAtIdCursorCodec,
      cursor: { createdAt: new Date(123), id: 'item-1' },
    },
    {
      codec: directoryCursorCodec,
      cursor: { dirtype: 1, createdAt: new Date(456), id: 'folder-1' },
    },
    {
      codec: trashCursorCodec,
      cursor: { trashedAt: 789, createdAt: new Date(456), id: 'trash-1' },
    },
  ])('round-trips typed cursors through the shared HTTP boundary', async ({ codec, cursor }) => {
    const query = await pageQueryFingerprint({ pageSize: 50 })
    const token = await encodeNextPageToken(platform(), cursor, { query, codec })

    await expect(decodeOptionalPageToken(platform(), token ?? undefined, { query, codec })).resolves.toEqual(cursor)
  })

  it('handles absent cursors without manufacturing tokens', async () => {
    const query = await pageQueryFingerprint({ pageSize: 50 })

    await expect(
      decodeOptionalPageToken(platform(), undefined, { query, codec: createdAtIdCursorCodec }),
    ).resolves.toBeUndefined()
    await expect(encodeNextPageToken(platform(), null, { query, codec: createdAtIdCursorCodec })).resolves.toBeNull()
  })

  it.each([
    { codec: createdAtIdCursorCodec, boundary: { createdAt: 'invalid', id: 'item-1' } },
    { codec: directoryCursorCodec, boundary: { createdAt: 1, id: 'item-1', dirtype: 'invalid' } },
    { codec: trashCursorCodec, boundary: { createdAt: 1, id: 'item-1', trashedAt: 'invalid' } },
  ])('rejects a signed token whose boundary does not match its codec', async ({ codec, boundary }) => {
    const query = await pageQueryFingerprint({ pageSize: 50 })
    const token = await encodePageToken(platform(), {
      boundary: boundary as never,
      query,
    })

    await expect(decodeOptionalPageToken(platform(), token, { query, codec })).rejects.toMatchObject({
      httpStatus: 400,
      meta: { reason: 'INVALID_PAGE_TOKEN' },
    })
  })

  it('fails fast when the admin credentials are missing', async () => {
    await expect(encodePageToken(platform(''), { boundary: { id: 'item-1' }, query: 'query' })).rejects.toThrow(
      'ZPAN_USERNAME and ZPAN_PASSWORD are required',
    )
  })

  it('verifies a token signed with the derived credential secret', async () => {
    const derived = await deriveAuthSecret(username, password)
    const payload = { v: 1, boundary: { id: 'item-1' }, query: 'query', expiresAt: 5_000 }
    const token = await signRawBody(JSON.stringify(payload), derived)

    await expect(decodePageToken(platform(), token, { query: 'query', now: 2_000 })).resolves.toEqual({
      id: 'item-1',
    })
  })

  it('rejects a correctly signed token with a malformed payload', async () => {
    const derived = await deriveAuthSecret(username, password)
    const token = await signRawBody('not-json', derived)

    await expect(decodePageToken(platform(), token, { query: 'query' })).rejects.toMatchObject({
      httpStatus: 400,
      meta: { reason: 'INVALID_PAGE_TOKEN' },
    })
  })
})
