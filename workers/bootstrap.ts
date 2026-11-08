import { waitUntil } from 'cloudflare:workers'
import { createCloudflareKvBackend } from '../server/adapters/cache/cloudflare-kv'
import { createRuntimeCache, resolveCacheMode } from '../server/adapters/cache/runtime-cache'
import { ensureAdminSeed } from '../server/adapters/repos/admin-seed'
import { createShareRepo } from '../server/adapters/repos/share'
import { createApp } from '../server/app'
import type { Auth } from '../server/auth'
import { createAuth } from '../server/auth'
import { createDeps } from '../server/composition'
import { isPotentialWebDavPublicRequest } from '../server/domain/webdav-public-url'
import { createCloudflarePlatform } from '../server/platform/cloudflare'
import { platformContext } from '../server/platform/context'
import type { Deps } from '../server/usecases/deps'
import type { CacheService } from '../server/usecases/ports'
import { resolveAuthSecret } from '../shared/auth-secret'
import { APP_INITIALIZATION_TIMEOUT_MS, DirType } from '../shared/constants'
import { handleScheduled } from './scheduled'

interface Env {
  DB: D1Database
  // Optional: when absent, the signing secret is derived from the admin credentials.
  BETTER_AUTH_SECRET?: string
  ZPAN_USERNAME?: string
  ZPAN_PASSWORD?: string
  ZPAN_PREVIEW?: string
  BETTER_AUTH_URL?: string
  TRUSTED_ORIGINS?: string
  ASSETS: Fetcher
  CACHE_KV?: KVNamespace
  [key: string]: unknown
}

const SHARE_TOKEN_RE = /^\/s\/([^/?#]+)/

function envReader(env: Env): (key: string) => string | undefined {
  return (key) => {
    const value = env[key]
    return typeof value === 'string' ? value : undefined
  }
}

// Cache auth instances at isolate scope to avoid per-request DB queries and
// better-auth init CPU. createAuth resolves $context before returning, so the
// cache never carries a pending promise tied to its creating request (which
// would hang every later auth call in the isolate). Fixed slots prevent a first
// request on the WebDAV hostname from fixing the primary app base URL without
// allowing arbitrary Host headers to grow the cache. Changes to OAuth provider
// configs or env vars take effect on isolate recycle.
type AuthSlot = 'configured' | 'primary' | 'webdav' | `preview:${string}`

interface WorkerRuntime {
  platform: ReturnType<typeof createCloudflarePlatform>
  deps: Deps
  cache: CacheService
  authBySlot: Map<AuthSlot, Auth>
  appBySlot: Map<AuthSlot, ReturnType<typeof createApp>>
  appInitBySlot: Map<AuthSlot, Promise<ReturnType<typeof createApp>>>
}

type InitializeApp = (
  runtime: WorkerRuntime,
  env: Env,
  baseURL: string,
  trustedOrigins: string[],
) => Promise<{ auth: Auth; app: ReturnType<typeof createApp> }>
type KeepAlive = (promise: Promise<unknown>) => void

const initializeApp: InitializeApp = async (runtime, env, baseURL, trustedOrigins) => {
  const secret = await resolveAuthSecret(envReader(env))
  const auth = await createAuth(runtime.platform, secret, baseURL, trustedOrigins, waitUntil)
  return { auth, app: createApp(runtime.platform, auth, runtime.deps) }
}

let cachedRuntime: WorkerRuntime | undefined
let adminSeedPromise: Promise<unknown> | undefined
const responseCache = (
  caches as unknown as {
    default: {
      match(request: Request): Promise<Response | undefined>
      put(request: Request, response: Response): Promise<void>
    }
  }
).default

function runtimeFor(env: Env): WorkerRuntime {
  if (cachedRuntime) return cachedRuntime

  const platform = createCloudflarePlatform(env)
  const distributed = env.CACHE_KV ? createCloudflareKvBackend(env.CACHE_KV) : undefined
  const cache = createRuntimeCache({
    mode: resolveCacheMode(env.ZPAN_CACHE_MODE as string | undefined, !!distributed),
    distributed,
  })
  cachedRuntime = {
    platform,
    cache,
    deps: createDeps(platform, { cache }),
    authBySlot: new Map(),
    appBySlot: new Map(),
    appInitBySlot: new Map(),
  }
  return cachedRuntime
}

export async function appForRequest(
  runtime: WorkerRuntime,
  request: Request,
  env: Env,
  initialize: InitializeApp = initializeApp,
  keepAlive: KeepAlive = waitUntil,
): Promise<ReturnType<typeof createApp>> {
  const origin = new URL(request.url).origin
  const webDavRequest = isPotentialWebDavPublicRequest(request.url)
  const inferredOrigin = origin
  const isPreview = env.ZPAN_PREVIEW === 'true'
  const baseURL = isPreview ? inferredOrigin : env.BETTER_AUTH_URL || inferredOrigin
  const trustedOrigins = env.TRUSTED_ORIGINS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) || [inferredOrigin]
  const slot: AuthSlot = isPreview
    ? `preview:${origin}`
    : env.BETTER_AUTH_URL
      ? 'configured'
      : webDavRequest
        ? 'webdav'
        : 'primary'

  const cachedApp = runtime.appBySlot.get(slot)
  const cachedAuth = runtime.authBySlot.get(slot)
  if (cachedApp && cachedAuth) return cachedApp

  const pendingApp = runtime.appInitBySlot.get(slot)
  if (pendingApp) return pendingApp

  // Keep the single cold-start initialization alive if its creating request is
  // canceled, and bound it so a genuinely stuck dependency cannot poison the slot.
  const appPromise = withTimeout(
    initialize(runtime, env, baseURL, trustedOrigins),
    APP_INITIALIZATION_TIMEOUT_MS,
    'Worker app initialization timed out',
  ).then(({ auth, app }) => {
    // Preview aliases and deployment URLs need separate auth origins. Bound the
    // isolate cache so historical deployment hostnames cannot accumulate forever.
    if (isPreview && runtime.appBySlot.size >= 8) {
      const oldest = runtime.appBySlot.keys().next().value
      if (oldest) {
        runtime.appBySlot.delete(oldest)
        runtime.authBySlot.delete(oldest)
      }
    }
    runtime.authBySlot.set(slot, auth)
    runtime.appBySlot.set(slot, app)
    return app
  })
  runtime.appInitBySlot.set(slot, appPromise)
  keepAlive(appPromise.catch(() => undefined))
  try {
    return await appPromise
  } finally {
    if (runtime.appInitBySlot.get(slot) === appPromise) runtime.appInitBySlot.delete(slot)
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Fail fast when neither an explicit secret nor the credential pair is set.
    // The same resolver (and its memoized derivation) feeds auth initialization.
    await resolveAuthSecret(envReader(env))
    const runtime = runtimeFor(env)
    // Single-user bootstrap: create the admin account from ZPAN_USERNAME/ZPAN_PASSWORD
    // when the instance is empty. Fire-and-forget; runs at most once per isolate.
    adminSeedPromise ??= ensureAdminSeed(runtime.platform).catch((error: unknown) => {
      console.error(`admin.seed.error code=${error instanceof Error ? error.message : String(error)}`)
    })
    await adminSeedPromise
    const edgeCached = await matchConfigzResponseCache(request, runtime.cache)
    if (edgeCached) return edgeCached
    const app = await appForRequest(runtime, request, env)

    return platformContext.run(runtime.platform, async () => {
      const url = new URL(request.url)
      const shareMatch = SHARE_TOKEN_RE.exec(url.pathname)

      if (shareMatch && request.method === 'GET') {
        return handleShareSsr(request, env, ctx, shareMatch[1], runtime.platform, app)
      }

      const response = await app.fetch(request, env, ctx)
      cacheConfigzResponse(request, response, runtime.cache, ctx)
      return response
    })
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await handleScheduled(event, env)
  },
}

function configzCacheKey(request: Request, includeValidators = false): Request | null {
  if (request.method !== 'GET') return null
  const url = new URL(request.url)
  if (url.pathname !== '/api/configz' && url.pathname !== '/api/configz/') return null
  url.search = ''
  const ifNoneMatch = request.headers.get('If-None-Match')
  return new Request(url.toString(), {
    method: 'GET',
    headers: includeValidators && ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : undefined,
  })
}

async function matchConfigzResponseCache(request: Request, cache: CacheService): Promise<Response | null> {
  if (cache.mode !== 'distributed') return null
  const key = configzCacheKey(request, true)
  if (!key) return null
  try {
    const matched = await responseCache.match(key)
    if (!matched) return null
    const response = new Response(matched.body, matched)
    response.headers.set('X-ZPan-Cache', 'edge')
    return response
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'cache.response.get.error',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

function cacheConfigzResponse(request: Request, response: Response, cache: CacheService, ctx: ExecutionContext): void {
  if (cache.mode !== 'distributed' || response.status !== 200) return
  const key = configzCacheKey(request)
  if (!key) return
  const task = responseCache.put(key, response.clone()).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        message: 'cache.response.put.error',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  })
  ctx.waitUntil(task)
}

interface ShareMeta {
  title: string
  description: string
  imageUrl: string
}

async function fetchShareMeta(
  platform: ReturnType<typeof createCloudflarePlatform>,
  origin: string,
  token: string,
): Promise<ShareMeta> {
  const fallback: ShareMeta = {
    title: 'Share unavailable',
    description: 'Shared via ZPan',
    imageUrl: `${origin}/logo-512.png`,
  }

  try {
    const resolved = await createShareRepo(platform.db).resolveByToken(token)
    if (resolved.status !== 'ok') return fallback
    if (resolved.share.kind !== 'landing') return fallback

    const { share, matter } = resolved
    const expiry = share.expiresAt ? ` · Expires ${new Date(share.expiresAt).toLocaleDateString()}` : ''
    const description = `Shared via ZPan${expiry}`
    const isImage = matter.type.startsWith('image/') && matter.dirtype === DirType.FILE

    return {
      title: matter.name,
      description,
      imageUrl: isImage ? `${origin}/api/share/${token}/download` : `${origin}/logo-512.png`,
    }
  } catch {
    return fallback
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function buildOgTags(meta: ShareMeta, pageUrl: string): string {
  return [
    `<meta property="og:title" content="${escapeAttr(meta.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(meta.description)}" />`,
    `<meta property="og:image" content="${escapeAttr(meta.imageUrl)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escapeAttr(pageUrl)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeAttr(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(meta.description)}" />`,
    `<meta name="twitter:image" content="${escapeAttr(meta.imageUrl)}" />`,
  ].join('\n    ')
}

async function handleShareSsr(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  platform: ReturnType<typeof createCloudflarePlatform>,
  app: ReturnType<typeof createApp>,
): Promise<Response> {
  const url = new URL(request.url)
  const origin = url.origin

  const [meta, spaRes] = await Promise.all([
    fetchShareMeta(platform, origin, token),
    env.ASSETS.fetch(new Request(`${origin}/index.html`, { headers: request.headers })),
  ])

  if (!spaRes.ok) {
    return app.fetch(request, env, ctx)
  }

  const html = await spaRes.text()
  const ogTags = buildOgTags(meta, url.href)
  const injected = html.replace(
    '<title>ZPan</title>',
    `<title>${meta.title.replace(/</g, '&lt;')} — ZPan</title>\n    ${ogTags}`,
  )

  return new Response(injected, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  })
}
