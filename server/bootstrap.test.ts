import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveAuthSecret } from '../shared/auth-secret'
import type { Platform } from './platform/interface'
import type { Deps } from './usecases/deps'

const app = { fetch: vi.fn() }
const auth = { api: {} }
const createAppMock = vi.hoisted(() => vi.fn(() => app))
const createAuthMock = vi.hoisted(() => vi.fn(async () => auth))

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
    expect(createAuthMock).toHaveBeenCalledWith(p, await deriveAuthSecret(username, password), 'https://zpan.test', [
      'http://localhost:5185',
    ])
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
    expect(createAuthMock).toHaveBeenCalledWith(p, 'explicit-secret', 'http://localhost:5185', [
      'http://localhost:5185',
    ])
  })

  it('fails fast when no credentials and no explicit secret are configured', async () => {
    const { platform: p } = platform({})
    await expect(createBootstrap(p, {} as Deps)).rejects.toThrow('ZPAN_USERNAME and ZPAN_PASSWORD are required')
    expect(createAuthMock).not.toHaveBeenCalled()
  })
})
