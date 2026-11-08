import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SystemOptionsRepo } from '../ports'
import { getSiteConfig } from './configz'

function makeDeps(entries: Array<[string, string]> = []) {
  const values = new Map(entries)
  const systemOptions: SystemOptionsRepo = {
    get: async (key) => (values.has(key) ? { key, value: values.get(key)! } : null),
    getValue: async (key) => values.get(key) ?? null,
    getMany: async (keys) => keys.flatMap((key) => (values.has(key) ? [{ key, value: values.get(key)! }] : [])),
    listByPrefix: async (prefix) =>
      [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    set: async () => {},
    setMany: async () => {},
    delete: async () => {},
  }
  return { systemOptions }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getSiteConfig', () => {
  it('returns a stable public document with defaults', async () => {
    const config = await getSiteConfig(makeDeps(), 'https://pan.example.com/api/configz')

    expect(config).toEqual({
      site: { name: 'ZPan', description: '', publicUrl: 'https://pan.example.com' },
      branding: {
        logoUrl: null,
        faviconUrl: null,
        wordmark: null,
        hidePoweredBy: false,
        theme: { mode: 'preset', preset: 'default', custom: null, configured: false },
      },
      services: { webdav: { enabled: true, url: 'https://pan.example.com/dav/' } },
    })
  })

  it('projects configured values', async () => {
    const config = await getSiteConfig(
      makeDeps([
        ['site_name', 'My ZPan'],
        ['site_description', 'Files'],
        ['site_public_origin', 'https://files.example.com'],
        ['webdav_verified_origin', 'https://dav.files.example.com'],
        ['branding_wordmark_text', 'My Cloud'],
        ['branding_hide_powered_by', 'true'],
      ]),
      'https://request.example.com/api/configz',
    )

    expect(config.site).toEqual({
      name: 'My ZPan',
      description: 'Files',
      publicUrl: 'https://files.example.com',
    })
    expect(config.branding.wordmark).toBe('My Cloud')
    expect(config.branding.hidePoweredBy).toBe(true)
    expect(config.services.webdav.url).toBe('https://dav.files.example.com/')
  })

  it('falls back to the path URL when the verified origin belongs to an old Public URL', async () => {
    const config = await getSiteConfig(
      makeDeps([
        ['site_public_origin', 'https://files.example.com'],
        ['webdav_verified_origin', 'https://dav.old.example.com'],
      ]),
      'https://request.example.com/api/configz',
    )

    expect(config.services.webdav.url).toBe('https://files.example.com/dav/')
  })

  it('publishes a configured WebDAV domain after that origin is verified', async () => {
    const config = await getSiteConfig(
      makeDeps([
        ['site_public_origin', 'https://files.example.com'],
        ['webdav_domain', 'webdisk.example.net'],
        ['webdav_verified_origin', 'https://webdisk.example.net'],
      ]),
      'https://request.example.com/api/configz',
    )

    expect(config.services.webdav.url).toBe('https://webdisk.example.net/')
  })

  it('publishes the WebDAV disabled state', async () => {
    const config = await getSiteConfig(makeDeps([['webdav_enabled', 'false']]), 'https://pan.example.com/api/configz')

    expect(config.services.webdav).toEqual({ enabled: false, url: 'https://pan.example.com/dav/' })
  })
})
