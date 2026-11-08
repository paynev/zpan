import { describe, expect, it, vi } from 'vitest'
import { buildImageStorageKey, buildObjectKey, fileExt } from './path-template.js'

const baseVars = {
  uid: 'user123',
  rawExt: '.jpg',
}

describe('buildObjectKey', () => {
  it('produces a user-scoped key with the fixed template', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'))

    const result = buildObjectKey(baseVars)
    // Base62 needs 17 characters to preserve the former 16-character Nano ID entropy.
    expect(result).toMatch(/^user123\/20260315\/[A-Za-z0-9]{17}\.jpg$/)

    vi.useRealTimers()
  })

  it('includes a 17-character Base62 random key', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'))

    const result = buildObjectKey(baseVars)
    const filename = result.split('/')[2]
    expect(filename.replace('.jpg', '')).toHaveLength(17)

    vi.useRealTimers()
  })

  it('handles empty rawExt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'))

    const result = buildObjectKey({ ...baseVars, rawExt: '' })
    expect(result).toMatch(/^user123\/20260315\/[A-Za-z0-9]{17}$/)

    vi.useRealTimers()
  })

  it('generates unique keys on each call', () => {
    const a = buildObjectKey(baseVars)
    const b = buildObjectKey(baseVars)
    expect(a).not.toBe(b)
  })

  it('accepts legacy owner IDs while keeping the generated key segment Base62', () => {
    const result = buildObjectKey({ ...baseVars, uid: 'legacy-user' })
    expect(result).toMatch(/^legacy-user\/\d{8}\/[A-Za-z0-9]{17}\.jpg$/)
  })

  it('rejects an unsafe user ID before creating a key', () => {
    expect(() => buildObjectKey({ ...baseVars, uid: 'invalid:user' })).toThrow('Invalid user ID for object storage key')
  })
})

describe('buildImageStorageKey', () => {
  it('uses compatible opaque ID components under the image namespace', () => {
    expect(buildImageStorageKey('imageABC123', 'png')).toBe('ih/imageABC123.png')
    expect(buildImageStorageKey('legacy-image', 'png')).toBe('ih/legacy-image.png')
  })

  it.each([
    ['image ID', 'invalid:image', 'png'],
    ['extension', 'imageABC123', 'png/other'],
  ])('rejects an invalid %s component', (_component, imageId, extension) => {
    expect(() => buildImageStorageKey(imageId, extension)).toThrow(/Invalid .* for image storage key/)
  })
})

describe('fileExt', () => {
  it('returns the extension with the leading dot', () => {
    expect(fileExt('photo.jpg')).toBe('.jpg')
    expect(fileExt('archive.tar.gz')).toBe('.gz')
    expect(fileExt('.hidden')).toBe('.hidden')
  })

  it('returns empty string when there is no extension', () => {
    expect(fileExt('README')).toBe('')
    expect(fileExt('')).toBe('')
  })
})
