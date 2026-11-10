import { describe, expect, it, vi } from 'vitest'
import { APP_INITIALIZATION_TIMEOUT_MS } from '../shared/constants'
import { appForRequest } from './bootstrap'

describe('[CF] Worker auth initialization recovery', () => {
  it('keeps preview and deployment authentication origins separate', async () => {
    const initialize = vi.fn().mockImplementation(async (_runtime, _env, baseURL) => ({ auth: {}, app: { baseURL } }))
    const runtime = { authBySlot: new Map(), appBySlot: new Map(), appInitBySlot: new Map() } as Parameters<
      typeof appForRequest
    >[0]
    const env = { ZPAN_PREVIEW: 'true', BETTER_AUTH_URL: 'https://old-staging.example.com' } as Parameters<
      typeof appForRequest
    >[2]
    const first = await appForRequest(
      runtime,
      new Request('https://branch-zpan.test.workers.dev/api'),
      env,
      initialize,
      vi.fn(),
    )
    const second = await appForRequest(
      runtime,
      new Request('https://deployment-zpan.test.workers.dev/api'),
      env,
      initialize,
      vi.fn(),
    )
    expect(first).toEqual({ baseURL: 'https://branch-zpan.test.workers.dev' })
    expect(second).toEqual({ baseURL: 'https://deployment-zpan.test.workers.dev' })
    expect(initialize).toHaveBeenCalledTimes(2)
  })

  it('resolves trusted origins for whichever CDN hostname serves the request', async () => {
    const initialize = vi.fn().mockImplementation(async (_runtime, _env, baseURL) => ({ auth: {}, app: { baseURL } }))
    const runtime = { authBySlot: new Map(), appBySlot: new Map(), appInitBySlot: new Map() } as Parameters<
      typeof appForRequest
    >[0]
    const env = {} as Parameters<typeof appForRequest>[2]

    await appForRequest(
      runtime,
      new Request('https://zpan-origin.workers.dev/api', {
        headers: { 'X-Forwarded-Host': 'zpan.digpat.com', 'X-Forwarded-Proto': 'https' },
      }),
      env,
      initialize,
      vi.fn(),
    )

    const trustedOrigins = initialize.mock.calls[0][3] as (request?: Request) => string[]
    expect(trustedOrigins()).toContain('https://zpan.digpat.com')
    expect(
      trustedOrigins(
        new Request('https://another-cdn.example/api', { headers: { Origin: 'https://another-cdn.example' } }),
      ),
    ).toContain('https://another-cdn.example')
  })

  it('starts a fresh initialization after an earlier request reaches its deadline', async () => {
    vi.useFakeTimers()
    try {
      const initialize = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValue({ auth: {}, app: { fetch: vi.fn() } })
      const keepAlive = vi.fn()
      const runtime = {
        authBySlot: new Map(),
        appBySlot: new Map(),
        appInitBySlot: new Map(),
      } as Parameters<typeof appForRequest>[0]
      const env = { BETTER_AUTH_SECRET: 'test-secret' } as Parameters<typeof appForRequest>[2]
      const request = new Request('https://recovery.example.com/api/health')

      const stuck = appForRequest(runtime, request, env, initialize, keepAlive)
      const timedOut = expect(stuck).rejects.toThrow('Worker app initialization timed out')
      expect(keepAlive).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(APP_INITIALIZATION_TIMEOUT_MS)
      await timedOut

      const recovered = appForRequest(runtime, request, env, initialize, keepAlive)

      expect(initialize).toHaveBeenCalledTimes(2)
      await expect(recovered).resolves.toEqual({ fetch: expect.any(Function) })
    } finally {
      vi.useRealTimers()
    }
  })
})
