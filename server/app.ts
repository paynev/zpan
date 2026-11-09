import { release as osRelease } from 'node:os'
import { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import type { Auth } from './auth'
import { cacheServerTiming, runWithCacheEvents } from './cache/context'
import { createDeps } from './composition'
import { isPotentialWebDavPublicRequest, isWebDavPublicRequest } from './domain/webdav-public-url'
import { adminStats } from './http/admin-stats'
import { ARAZZO_DOCUMENT_PATH, ARAZZO_MEDIA_TYPE, createArazzoDocument } from './http/arazzo'
import { configz } from './http/configz'
import { events } from './http/events'
import internal from './http/internal'
import { notifications } from './http/notifications'
import objects from './http/objects'
import { addRequestIdOpenApi } from './http/openapi'
import redirect from './http/redirect'
import { authedShares, publicShares } from './http/shares'
import { announcements } from './http/site/announcements'
import { adminAudit } from './http/site/audit'
import { brandingAdmin } from './http/site/branding'
import { siteSettings } from './http/site/settings'
import storages from './http/site/storages'
import system from './http/site/system'
import trash from './http/trash'
import webdav from './http/webdav'
import { formatError } from './lib/errors'
import { auditMiddleware } from './middleware/audit'
import { authMiddleware } from './middleware/auth'
import { isHandledError, jsonError } from './middleware/error-handler'
import { accessLog } from './middleware/logger'
import type { Env } from './middleware/platform'
import { platformMiddleware } from './middleware/platform'
import type { Platform } from './platform/interface'
import { getDeployPlatform } from './runtime-platform'
import type { Deps } from './usecases/deps'
import { INSTANCE_TELEMETRY_CRON, reportInstanceTelemetry } from './usecases/site/instance-telemetry'
import { ensureSitePublicOrigin } from './usecases/site/public-origin'
import { getSiteRoutingConfig } from './usecases/site/routing-config'

export function createApp(platform: Platform, auth: Auth, deps: Deps = createDeps(platform)) {
  const app = new OpenAPIHono<Env>()
  const corsOrigins = getCorsOrigins(platform)

  app.use('/*', platformMiddleware(platform, auth))
  app.use('/*', async (c, next) => {
    // An SSE connection outlives the response setup by minutes. Keeping request
    // diagnostics attached would retain its AsyncLocalStorage store for the
    // whole stream even though the polling loop does not use the cache.
    if (c.req.path === '/api/events' || c.req.path === '/api/events/') {
      await next()
      return
    }
    await runWithCacheEvents(async () => {
      await next()
      const serverTiming = cacheServerTiming()
      if (serverTiming) c.res.headers.append('Server-Timing', serverTiming)
    })
  })
  app.use('/*', async (c, next) => {
    c.set('deps', deps)
    await next()
  })
  app.use('/*', async (c, next) => {
    if (platform.getEnv('ZPAN_PREVIEW') === 'true') {
      const routing = await getSiteRoutingConfig(deps)
      c.set('sitePublicOrigin', new URL(c.req.url).origin)
      c.set('webDavEnabled', routing.webDavEnabled)
      c.set('webDavDomain', '')
      await next()
      return
    }
    if (isPotentialWebDavPublicRequest(c.req.url)) {
      const routing = await getSiteRoutingConfig(deps)
      c.set('webDavEnabled', routing.webDavEnabled)
      c.set('webDavDomain', routing.webDavDomain)
      const routingOrigin = routing.publicOrigin ?? (routing.webDavDomain ? new URL(c.req.url).origin : null)
      if (routing.webDavEnabled && isWebDavPublicRequest(c.req.url, routingOrigin, routing.webDavDomain)) {
        c.set('sitePublicOrigin', routingOrigin)
        c.set('webDavMountPath', '')
        await next()
        return
      }
    }
    const result = await ensureSitePublicOrigin(deps, c.req.url).catch((err) => {
      console.error(`site.public_origin.detect.error code=${formatError(err)}`)
      return { origin: null, created: false }
    })
    c.set('sitePublicOrigin', result.origin)

    if (result.created && result.origin && shouldReportInitialTelemetry(c.req.url)) {
      const task = reportInstanceTelemetry(deps, {
        config: {
          siteUrl: result.origin,
          allowIp: envAllowsIp(platform.getEnv('ZPAN_TELEMETRY_ALLOW_IP')),
        },
        cron: INSTANCE_TELEMETRY_CRON,
        trigger: 'runtime',
        runtime: instanceTelemetryRuntime(platform),
      }).catch((err) => {
        console.error(`instance.telemetry.initial_report.error code=${formatError(err)}`)
      })
      waitUntil(c, task)
    }

    await next()
  })
  app.use('/api/*', accessLog)
  app.use('/dav', accessLog)
  app.use('/dav/*', accessLog)

  app.use(
    '/api/*',
    cors({
      origin: (origin) => (origin && corsOrigins.has(origin) ? origin : null),
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['Request-Id'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true,
    }),
  )

  app.on(['POST', 'GET', 'HEAD', 'PUT', 'DELETE'], '/api/auth/*', async (c) => {
    const a = c.get('auth')
    return a.handler(c.req.raw)
  })

  app.get('/api', (c) => {
    c.header(
      'Link',
      [
        '</api/openapi.json>; rel="service-desc"; type="application/openapi+json"',
        `<${ARAZZO_DOCUMENT_PATH}>; rel="describedby"; type="application/vnd.oai.workflows+json"`,
      ].join(', '),
    )
    return c.json({ name: 'ZPan API', openapi: '/api/openapi.json', workflows: ARAZZO_DOCUMENT_PATH })
  })

  app.on(['GET', 'HEAD'], ARAZZO_DOCUMENT_PATH, (c) => {
    const headers = {
      'Cache-Control': 'public, max-age=300',
      'Content-Type': ARAZZO_MEDIA_TYPE,
    }
    if (c.req.method === 'HEAD') return c.newResponse(null, 200, headers)
    return c.newResponse(JSON.stringify(createArazzoDocument(new URL(c.req.url).origin)), 200, headers)
  })

  // Global OpenAPI document. ZPan routes defined with `.openapi()` are
  // aggregated across all mounted sub-apps.
  app.get('/api/openapi.json', async (c) => {
    const doc = app.getOpenAPIDocument({
      openapi: '3.1.0',
      info: { title: 'ZPan API', version: '0.1.0' },
      servers: [{ url: '/', description: 'Current ZPan origin' }],
      externalDocs: {
        description: 'Machine-readable API workflows (Arazzo 1.1)',
        url: ARAZZO_DOCUMENT_PATH,
      },
      // Top-level tag order + descriptions; Scalar groups operations by these.
      tags: [
        { name: 'Objects', description: 'Files and folders, including S3 multipart upload sessions' },
        { name: 'Events', description: 'Multiplexed server-sent event stream' },
      ],
    })

    doc.components ??= {}
    doc.components.securitySchemes = {
      ...(doc.components.securitySchemes ?? {}),
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'zp.session_token' },
      bearerAuth: { type: 'http', scheme: 'bearer' },
    }

    addRequestIdOpenApi(doc)

    return c.json(doc)
  })

  // Scalar interactive API reference for the global document above. Our own
  // resources live here; better-auth serves its own reference at /api/auth/reference.
  app.get('/api/docs', Scalar({ url: '/api/openapi.json', title: 'ZPan API' }))

  app.route('/dav', webdav)

  // Resolve the caller's principal for API routes that can use it. Public,
  // identity-independent health/config responses skip session resolution so
  // their hot path does not touch auth tables.
  const skipsPrincipalResolution = (path: string) =>
    path === '/api/configz' || path === '/api/configz/' || path === '/api/health'

  // authMiddleware is soft-fail: it resolves the protocol-specific credential
  // into a principal and protocol-neutral authorization context. Each authRoute
  // declaration then performs the runtime authorization, so one router can mix
  // public and protected endpoints without a second guard mapping.
  app.use('/api/*', async (c, next) => {
    if (skipsPrincipalResolution(c.req.path)) {
      await next()
      return
    }
    await authMiddleware(c, next)
  })
  app.use('/api/*', async (c, next) => {
    if (skipsPrincipalResolution(c.req.path)) {
      await next()
      return
    }
    await auditMiddleware(c, next)
  })

  // Public routes — no per-route auth guard.
  // /api/shares/:token endpoints are covered by run_worker_first=["/api/*"] in wrangler.toml.
  // /r/* is listed separately in run_worker_first.
  // /s/:token is intentionally left for the SPA landing page.
  app.route('/api/shares', publicShares)
  app.route('/api/configz', configz)
  app.route('/r', redirect)
  app.route('/api/internal', internal)

  app.route('/api/site/announcements', announcements)

  // Mount routes separately to avoid deep type chain accumulation.
  // Each .route() call is independent — TypeScript doesn't stack types.
  // Authorization comes from each authRoute declaration, so a single resource
  // path can serve public, user, and admin callers.
  app.route('/api/objects', objects)
  app.route('/api/shares', authedShares)
  app.route('/api/trash', trash)
  app.route('/api/site/storages', storages)
  app.route('/api/site/settings', siteSettings)
  app.route('/api/site', system)
  app.route('/api/notifications', notifications)
  app.route('/api/events', events)
  app.route('/api/site/settings/branding', brandingAdmin)
  app.route('/api/site/audit-events', adminAudit)
  app.route('/api/site/analytics', adminStats)

  app.get('/api/health', (c) => c.json({ status: 'ok' }))

  // Backstop for errors thrown outside the accessLog boundary (earlier middleware,
  // or routes without accessLog like /r). For /api and /dav, accessLog already
  // catches and renders via the same `jsonError`, so this rarely fires there.
  // Genuinely unhandled errors are logged here since those routes aren't access-
  // logged; AppError/mapped cases are already carried by their access-log line.
  app.onError((err, c) => {
    if (!isHandledError(err)) console.error(`http.unhandled_error code=${formatError(err)}`)
    return jsonError(c, err)
  })

  return app
}

function envAllowsIp(value: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes(value?.trim().toLowerCase() ?? '')
}

function instanceTelemetryRuntime(platform: Platform) {
  if (platform.getBinding('DB')) {
    return {
      runtime: 'workerd' as const,
      platform: 'cloudflare-workers' as const,
    }
  }

  return {
    runtime: 'node' as const,
    platform: getDeployPlatform() ?? 'node',
    osPlatform: process.platform,
    osArch: process.arch,
    osRelease: osRelease(),
    nodeVersion: process.version,
  }
}

function waitUntil(c: Context, task: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(task)
    return
  } catch {
    void task
  }
}

function shouldReportInitialTelemetry(requestUrl: string): boolean {
  const url = new URL(requestUrl)
  if (url.pathname === '/api/internal/instance-telemetry/report') return false
  return !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

function getCorsOrigins(platform: Platform): Set<string> {
  const origins = new Set<string>()
  const addOrigin = (value: string | undefined) => {
    if (!value) return
    try {
      origins.add(new URL(value).origin)
    } catch {
      origins.add(value)
    }
  }

  addOrigin(platform.getEnv('BETTER_AUTH_URL'))
  for (const origin of platform.getEnv('TRUSTED_ORIGINS')?.split(',') ?? []) {
    addOrigin(origin.trim())
  }

  return origins
}

export type AppType = ReturnType<typeof createApp>

// Sub-router types for RPC clients — avoids combined AppType OOM
export type ObjectsRoute = typeof objects
export type PublicSharesRoute = typeof publicShares
export type AuthedSharesRoute = typeof authedShares
export type TrashRoute = typeof trash
export type StoragesRoute = typeof storages
export type SystemRoute = typeof system
export type ConfigzRoute = typeof configz
export type SiteSettingsRoute = typeof siteSettings
export type NotificationsRoute = typeof notifications
export type EventsRoute = typeof events
export type AnnouncementsRoute = typeof announcements
export type BrandingAdminRoute = typeof brandingAdmin
export type AdminAuditRoute = typeof adminAudit
export type AdminStatsRoute = typeof adminStats
