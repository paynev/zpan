import { apiKey } from '@better-auth/api-key'
import { APIError, type BetterAuthOptions, betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { openAPI } from 'better-auth/plugins'
import { count } from 'drizzle-orm'
import {
  ApiKeyTemplate,
  WEBDAV_API_KEY_PERMISSIONS,
  WEBDAV_API_KEY_RATE_LIMIT_MAX_REQUESTS,
  WEBDAV_API_KEY_RATE_LIMIT_WINDOW_MS,
  WEBDAV_RATE_LIMITER_BINDING,
} from '../shared/api-key-templates'
import { BASE62_PATTERN, generateId, generateToken } from '../shared/ids'
import { recordUserActivity } from './adapters/repos/user-activity'
import * as authSchema from './db/auth-schema'
import { hashPassword, verifyPassword as verifyPasswordHash } from './lib/password'
import { createDbProxy, createPlatformProxy } from './platform/context'
import type { Database, Platform } from './platform/interface'

// better-auth's default password hasher is pure-JS scrypt from @noble/hashes,
// which blows past Cloudflare Workers' CPU budget and triggers error 1102.
// We use node:crypto.scryptSync via server/lib/password.ts (native OpenSSL,
// counted as I/O rather than JS CPU time on CF Workers).

async function authHashPassword(password: string): Promise<string> {
  return hashPassword(password)
}

async function authVerifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  if (!hash.includes(':')) throw new Error('stored password hash is malformed: expected "<salt>:<key>"')
  return verifyPasswordHash(hash, password)
}

interface AuthPasswordProvider {
  hash(password: string): Promise<string>
  verify(input: { hash: string; password: string }): Promise<boolean>
}

const productionPasswordProvider: AuthPasswordProvider = {
  hash: authHashPassword,
  verify: authVerifyPassword,
}

function generateApiKey({ length, prefix }: { length: number; prefix: string | undefined }): string {
  if (prefix && !BASE62_PATTERN.test(prefix)) {
    throw new APIError('BAD_REQUEST', { message: 'API key prefixes must contain only ASCII letters and digits' })
  }
  return `${prefix ?? ''}${generateToken(length)}`
}

export async function createAuth(
  initialSource: Database | Platform,
  secret: string,
  baseURL?: string,
  _trustedOrigins?: string[],
  backgroundTaskHandler?: (promise: Promise<unknown>) => void,
  passwordProvider: AuthPasswordProvider = productionPasswordProvider,
) {
  const isPlatform = 'db' in initialSource
  const rawPlatform = isPlatform ? initialSource : null
  const rawDb = isPlatform ? initialSource.db : initialSource

  const platformProxy = rawPlatform ? createPlatformProxy(rawPlatform) : null
  const dbProxy = platformProxy ? platformProxy.db : createDbProxy(rawDb)

  const db = dbProxy
  // On the bare-Database path (tests, Node fallbacks) there is no platform, so
  // wrap the db proxy in a binding-free Platform for binding lookups.
  const authPlatform: Platform = platformProxy ?? { db: dbProxy, getEnv: () => undefined, getBinding: () => undefined }
  const usesNativeWebDavRateLimit = Boolean(authPlatform.getBinding(WEBDAV_RATE_LIMITER_BINDING))

  const authOptions = {
    database: drizzleAdapter(db, { provider: 'sqlite', schema: authSchema }),
    secret,
    baseURL,
    basePath: '/api/auth',
    advanced: {
      cookiePrefix: 'zp',
      database: { generateId: () => generateId() },
      // Explicitly enable the origin check (production default). Without this,
      // better-auth silently disables it under NODE_ENV=test, so tests would
      // never exercise the real CSRF/origin behavior.
      disableOriginCheck: false,
      ...(backgroundTaskHandler ? { backgroundTasks: { handler: backgroundTaskHandler } } : {}),
    },
    user: {
      additionalFields: {
        role: { type: 'string', required: false, input: false, returned: true },
        lastActiveAt: { type: 'date', required: false, input: false, returned: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      password: {
        hash: passwordProvider.hash,
        verify: passwordProvider.verify,
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 300,
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/delete-user') {
          throw new APIError('FORBIDDEN', { message: 'Self-service account deletion is not available' })
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.context.returned instanceof APIError) return
        const session = await getSessionFromCtx(ctx)
        const actorId = session?.user?.id
        if (!actorId) return
        await recordUserActivity(db, actorId)
      }),
    },
    plugins: [
      openAPI(),
      apiKey([
        {
          configId: ApiKeyTemplate.WEBDAV,
          customKeyGenerator: generateApiKey,
          references: 'user',
          enableMetadata: true,
          // Cloudflare's native limiter remains the authoritative synchronous
          // rate limit. Better Auth can therefore move its bookkeeping write
          // off the response path without weakening enforcement.
          deferUpdates: usesNativeWebDavRateLimit && backgroundTaskHandler !== undefined,
          rateLimit: {
            enabled: !usesNativeWebDavRateLimit,
            // Filesystem clients such as macOS Finder issue bursts of PROPFIND
            // and stat requests while browsing mounted folders.
            timeWindow: WEBDAV_API_KEY_RATE_LIMIT_WINDOW_MS,
            maxRequests: WEBDAV_API_KEY_RATE_LIMIT_MAX_REQUESTS,
          },
          permissions: {
            defaultPermissions: WEBDAV_API_KEY_PERMISSIONS,
          },
        },
      ]),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Single-user mode: the one admin account is created from
            // ZPAN_USERNAME/ZPAN_PASSWORD at startup — self-service sign-up is
            // never allowed.
            const firstUser = await isFirstUser(db)
            if (!firstUser) {
              throw new Error('Registration is disabled on this instance')
            }
            const data: Record<string, unknown> = { ...user, role: 'admin' }
            return { data }
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await recordUserActivity(db, session.userId)
          },
        },
      },
    },
  } satisfies BetterAuthOptions

  const auth = betterAuth(authOptions)

  // betterAuth() starts its lazy $context init synchronously, inside whichever
  // request constructs the instance. Resolve it here so a cached instance never
  // carries a pending promise tied to its creating request — on Cloudflare
  // Workers such a promise never settles when awaited from a later request,
  // which would hang every auth call in the isolate.
  await auth.$context
  return auth
}

export type Auth = Awaited<ReturnType<typeof createAuth>>

async function isFirstUser(db: Database): Promise<boolean> {
  const [row] = await db.select({ c: count() }).from(authSchema.user)
  if (!row) throw new Error('count(*) on user table returned no rows')
  return row.c === 0
}
