import { resolveAuthSecret } from '../shared/auth-secret'
import { ensureAdminSeed } from './adapters/repos/admin-seed'
import { createApp } from './app'
import { createAuth } from './auth'
import { createDeps } from './composition'
import { createDynamicTrustedOrigins } from './lib/request-origin'
import type { Platform } from './platform/interface'
import type { Deps } from './usecases/deps'

export async function createBootstrap(platform: Platform, deps: Deps = createDeps(platform)) {
  // Derived from ZPAN_USERNAME / ZPAN_PASSWORD unless an explicit
  // BETTER_AUTH_SECRET is supplied (backwards compatibility).
  const secret = await resolveAuthSecret((key) => platform.getEnv(key))

  // Single-user bootstrap: create the admin account from ZPAN_USERNAME/ZPAN_PASSWORD
  // when the instance is empty.
  await ensureAdminSeed(platform).catch((err) => {
    console.error(`admin.seed.error code=${err instanceof Error ? err.message : String(err)}`)
  })

  const baseURL = platform.getEnv('BETTER_AUTH_URL') || 'http://localhost:5185'
  // Same dynamic resolver as the Worker entry: a reverse proxy may rewrite
  // Host, so trust the public origin of each request as well as configured URLs.
  const trustedOrigins = createDynamicTrustedOrigins([
    baseURL,
    ...(platform.getEnv('TRUSTED_ORIGINS')?.split(',') ?? []),
  ])

  const auth = await createAuth(platform, secret, baseURL, trustedOrigins)
  return createApp(platform, auth, deps)
}
