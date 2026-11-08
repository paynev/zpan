import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemOptionsRepo } from '../ports'
import {
  getSiteSettings,
  type SiteSettingsDeps,
  updateSiteIdentity,
  updateSiteWebDav,
  verifySiteWebDav,
} from './settings'

function makeDeps(entries: Array<[string, string]> = []) {
  const values = new Map(entries)
  const set = vi.fn(async (key: string, value: string) => {
    values.set(key, value)
  })
  const setMany = vi.fn(async (rows: Array<{ key: string; value: string }>) => {
    for (const row of rows) values.set(row.key, row.value)
  })
  const systemOptions: SystemOptionsRepo = {
    get: async (key) => (values.has(key) ? { key, value: values.get(key)! } : null),
    getValue: async (key) => values.get(key) ?? null,
    getMany: async (keys) => keys.flatMap((key) => (values.has(key) ? [{ key, value: values.get(key)! }] : [])),
    listByPrefix: async (prefix) =>
      [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    set,
    setMany,
    delete: async (key) => {
      values.delete(key)
    },
  }
  const deps: SiteSettingsDeps = {
    systemOptions,
  }
  return { deps, values, set, setMany }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('site settings usecase', () => {
  it('returns structured defaults', async () => {
    const settings = await getSiteSettings(makeDeps().deps, 'https://pan.example.com/api/site/settings')

    expect(settings).toEqual({
      identity: { name: 'ZPan', description: '', publicUrl: 'https://pan.example.com' },
      webdav: {
        enabled: true,
        domain: '',
        pathUrl: 'https://pan.example.com/dav/',
        candidateUrl: 'https://dav.pan.example.com/',
        status: 'unverified',
        lastVerifiedAt: null,
        error: null,
      },
    })
  })

  it('updates Public URL and normalizes the trailing slash', async () => {
    const { deps, setMany } = makeDeps()
    const result = await updateSiteIdentity(deps, {
      name: 'ZPan',
      description: '',
      publicUrl: 'https://files.example.com/',
    })

    expect(result.publicUrl).toBe('https://files.example.com')
    expect(setMany).toHaveBeenCalledWith(
      expect.arrayContaining([{ key: 'site_public_origin', value: 'https://files.example.com' }]),
    )
    expect(setMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        { key: 'webdav_verified_origin', value: '' },
        { key: 'webdav_verified_at', value: '' },
        { key: 'webdav_verification_error', value: '' },
      ]),
    )
  })

  it('keeps the verification state when the Public URL is unchanged', async () => {
    const { deps, setMany } = makeDeps([
      ['site_public_origin', 'https://files.example.com'],
      ['webdav_verified_origin', 'https://dav.files.example.com'],
    ])

    await updateSiteIdentity(deps, { name: 'ZPan', description: '', publicUrl: 'https://files.example.com' })

    expect(setMany).not.toHaveBeenCalledWith(expect.arrayContaining([{ key: 'webdav_verified_origin', value: '' }]))
  })

  it('verifies and records the derived WebDAV origin', async () => {
    const { deps, values } = makeDeps([['site_public_origin', 'https://files.example.com']])
    const fetcher = vi.fn(
      async () =>
        new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="ZPan WebDAV"' },
        }),
    ) as typeof fetch

    const result = await verifySiteWebDav(
      deps,
      'https://files.example.com/api/site/settings/webdav/verifications',
      fetcher,
    )

    expect(fetcher).toHaveBeenCalledWith(
      'https://dav.files.example.com/',
      expect.objectContaining({ method: 'OPTIONS', redirect: 'manual' }),
    )
    expect(result).toMatchObject({
      candidateUrl: 'https://dav.files.example.com/',
      status: 'ready',
      error: null,
    })
    expect(result.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(values.get('webdav_verified_origin')).toBe('https://dav.files.example.com')
  })

  it('verifies and records the configured WebDAV domain', async () => {
    const { deps, values } = makeDeps([
      ['site_public_origin', 'https://files.example.com'],
      ['webdav_domain', 'webdisk.example.net'],
    ])
    const fetcher = vi.fn(
      async () =>
        new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="ZPan WebDAV"' },
        }),
    ) as typeof fetch

    const result = await verifySiteWebDav(
      deps,
      'https://files.example.com/api/site/settings/webdav/verifications',
      fetcher,
    )

    expect(fetcher).toHaveBeenCalledWith(
      'https://webdisk.example.net/',
      expect.objectContaining({ method: 'OPTIONS', redirect: 'manual' }),
    )
    expect(result).toMatchObject({ candidateUrl: 'https://webdisk.example.net/', status: 'ready' })
    expect(values.get('webdav_verified_origin')).toBe('https://webdisk.example.net')
  })

  it('updates WebDAV enablement and domain and clears stale verification', async () => {
    const { deps, values } = makeDeps([
      ['site_public_origin', 'https://files.example.com'],
      ['webdav_domain', 'dav.old.example.com'],
      ['webdav_verified_origin', 'https://dav.old.example.com'],
    ])

    const result = await updateSiteWebDav(
      deps,
      { enabled: false, domain: 'WebDisk.Example.net' },
      'https://files.example.com/api/site/settings/webdav',
    )

    expect(result).toMatchObject({
      enabled: false,
      domain: 'webdisk.example.net',
      candidateUrl: 'https://webdisk.example.net/',
      status: 'disabled',
    })
    expect(values.get('webdav_enabled')).toBe('false')
    expect(values.get('webdav_verified_origin')).toBe('')
  })

  it('rejects domain verification while WebDAV is disabled', async () => {
    const { deps } = makeDeps([
      ['site_public_origin', 'https://files.example.com'],
      ['webdav_enabled', 'false'],
    ])

    await expect(
      verifySiteWebDav(
        deps,
        'https://files.example.com/api/site/settings/webdav/verifications',
        vi.fn() as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ httpStatus: 400 })
  })

  it('stores a failed verification and keeps the path URL available', async () => {
    const { deps, values } = makeDeps([['site_public_origin', 'https://files.example.com']])
    const fetcher = vi.fn(async () => new Response('Not Found', { status: 404 })) as typeof fetch

    const result = await verifySiteWebDav(
      deps,
      'https://files.example.com/api/site/settings/webdav/verifications',
      fetcher,
    )

    expect(result).toEqual({
      enabled: true,
      domain: '',
      pathUrl: 'https://files.example.com/dav/',
      candidateUrl: 'https://dav.files.example.com/',
      status: 'failed',
      lastVerifiedAt: null,
      error: 'WebDAV verification returned HTTP 404 without the expected authentication challenge.',
    })
    expect(values.get('webdav_verified_origin')).toBe('')
  })
})
