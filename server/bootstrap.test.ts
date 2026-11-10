import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveAuthSecret } from '../shared/auth-secret'
import type { Platform } from './platform/interface'
import type { Deps } from './usecases/deps'

const app = { fetch: vi.fn() }
const auth = { api: {} }
const createAppMock = vi.hoisted(() => vi.fn(() => app))
// Keep the mock's parameter tuple long enough for assertions on the 4th
// argument (trustedOrigins); a zero-arg vi.fn() types calls as `[]`.
const createAuthMock = vi.hoisted(() =>
  vi.fn(async (_source: unknown, _secret: unknown, _baseURL?: unknown, _trustedOrigins?: unknown) => auth),
)

vi.mock('./app', () => ({ createApp: createAppMock }))
vi.mock('./auth', () => ({ createAuth: createAuthMock }))

import { createBootstrap } from './bootstrap'

const username = 'admin@zpan.test'
const password = 'test-password'

function platform(values: Record<string, string | undefined>) {
  const db = {
    all: vi.fn(),
    run: vi.fn(),
    // ensureAdminSeed sees a non-empty user table and short-circuits.
    select: vi.fn(() => ({ from: vi.fn(() => Promise.resolve([{ c: 1 }])) })),
  }
  return {
    db,
    platform: {
      db,
      getEnv: (name: string) => values[name],
    } as unknown as Platform,
  }
}

describe('Node bootstrap', () => {
  beforeEach(() => {
    createAppMock.mockClear()
    createAuthMock.mockClear()
  })

  it('derives the auth secret from ZPAN_USERNAME / ZPAN_PASSWORD', async () => {
    const { platform: p, db } = platform({
      ZPAN_USERNAME: username,
      ZPAN_PASSWORD: password,
      BETTER_AUTH_URL: 'https://zpan.test',
    })
    const deps = {} as Deps

    await expect(createBootstrap(p, deps)).resolves.toBe(app)
    expect(createAuthMock).toHaveBeenCalledWith(
      p,
      await deriveAuthSecret(username, password),
      'https://zpan.test',
      expect.any(Function),
    )
    const trustedOrigins = createAuthMock.mock.calls[0][3] as (request?: Request) => string[]
    expect(trustedOrigins()).toEqual(['https://zpan.test'])
    expect(
      trustedOrigins(
        new Request('http://localhost:8222/api', {
          headers: { 'X-Forwarded-Host': 'pan.example.com', 'X-Forwarded-Proto': 'https' },
        }),
      ),
    ).toContain('https://pan.example.com')
    expect(createAppMock).toHaveBeenCalledWith(p, auth, deps)
    expect(db.all).not.toHaveBeenCalled()
    expect(db.run).not.toHaveBeenCalled()
  })

  it('still honours an explicit BETTER_AUTH_SECRET', async () => {
    const { platform: p } = platform({
      ZPAN_USERNAME: username,
      ZPAN_PASSWORD: password,
      BETTER_AUTH_SECRET: 'explicit-secret',
    })

    await expect(createBootstrap(p, {} as Deps)).resolves.toBe(app)
    expect(createAuthMock).toHaveBeenCalledWith(p, 'explicit-secret', 'http://localhost:5185', expect.any(Function))
  })

  it('fails fast when no credentials and no explicit secret are configured', async () => {
    const { platform: p } = platform({})
    await expect(createBootstrap(p, {} as Deps)).rejects.toThrow('ZPAN_USERNAME and ZPAN_PASSWORD are required')
    expect(createAuthMock).not.toHaveBeenCalled()
  })
})
