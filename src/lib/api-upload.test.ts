import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UploadPartOptions } from './api'
import { uploadPartToS3 } from './api'

// api.ts builds typed RPC clients at import time; the upload helper under test
// does not touch them, but Vitest requires every named export to exist.
vi.mock('./rpc', () => ({
  authedSharesApi: {},
  brandingAdminApi: {},
  configzApi: {},
  eventsUrlApi: {},
  notificationsApi: {},
  objects: {},
  publicSharesApi: {},
  siteSettingsApi: {},
  storages: {},
  system: {},
  trash: {},
}))

class FakeXHR {
  static headers: Record<string, string | null> = {}
  status = 200
  upload = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  open() {}
  setRequestHeader() {}
  getResponseHeader(name: string) {
    return FakeXHR.headers[name.toLowerCase()] ?? null
  }
  abort() {
    this.onabort?.()
  }
  send() {
    this.onload?.()
  }
}

function put(etag: string | null, options: UploadPartOptions = {}) {
  FakeXHR.headers = etag === null ? {} : { etag }
  return uploadPartToS3('https://s3.example/part', new Blob(['x']), options)
}

describe('uploadPartToS3', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    FakeXHR.headers = {}
  })

  it('returns the response ETag with surrounding quotes stripped', async () => {
    await expect(put('"abc123"')).resolves.toBe('abc123')
  })

  it('allows a missing ETag for a single PutObject and still reports completion', async () => {
    const onProgress = vi.fn()

    await expect(put(null, { requireETag: false, onProgress })).resolves.toBe('')
    expect(onProgress).toHaveBeenCalledWith({ loaded: 1, total: 1 })
  })

  it('rejects a missing ETag when multipart completion needs it', async () => {
    await expect(put(null)).rejects.toThrow('Missing ETag')
    await expect(put(null, { requireETag: true })).rejects.toThrow('Missing ETag')
  })
})
