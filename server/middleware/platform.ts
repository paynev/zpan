import type { AuthorizationScope } from '@shared/authorization'
import { createMiddleware } from 'hono/factory'
import type { Auth } from '../auth'
import type { DavLock } from '../domain/webdav'
import type { WebDavMountPath } from '../domain/webdav-public-url'
import type { Platform } from '../platform/interface'
import type { Deps } from '../usecases/deps'
import type { ActorIdentity, WebDavTarget } from '../usecases/ports'
import type { TransferAuditTarget } from '../usecases/transfer-activity'

export type Env = {
  Variables: {
    platform: Platform
    auth: Auth
    deps: Deps
    principal: AuthPrincipal | null
    authzContext: AuthzContext
    userId: string | null
    userRole: string | null
    sitePublicOrigin: string | null
    webDavEnabled: boolean
    webDavDomain: string
    webDavMountPath: WebDavMountPath
    webDavTrace: string[]
    webDavDownloadAuditTarget: TransferAuditTarget | null
    redirectDownloadAuditTarget: TransferAuditTarget | null
    webDavResolvedPutTarget: WebDavTarget | null
    webDavUploadAuditTarget: TransferAuditTarget | null
    webDavLocksByResource: Map<string, DavLock[]>
    requestId: string
    // Structured detail for the access log on a failed request. Set by `jsonError`
    // (via `app.onError`); read by the accessLog middleware so every 4xx/5xx carries
    // its reason + full message, not just unhandled crashes.
    errorLog: { reason: string; message: string; diagnostic?: string } | null
  }
}

export type AuthPrincipal =
  | {
      kind: 'user'
      userId: string
      role?: string
      authMethod: 'cookie'
    }
  | {
      kind: 'api-key'
      keyId: string
      configId: string
      userId: string
      permissions: Record<string, string[]> | null
      authMethod: 'api-key'
    }

export type AuthzContext =
  | {
      credential: 'anonymous'
      userId: null
      grantedScopes: null
      actor: null
    }
  | {
      credential: 'session'
      userId: string
      grantedScopes: ReadonlySet<AuthorizationScope>
      actor: { type: 'user'; ref: string }
      state: { firstParty: true; role?: string }
    }
  | {
      credential: 'api_key'
      userId: string
      grantedScopes: ReadonlySet<AuthorizationScope>
      actor: { type: 'api_key'; ref: string }
      state: { configId: string; enabled: true }
    }

export function authzActorIdentity(context: AuthzContext): ActorIdentity | null {
  if (!context.actor) return null
  return {
    type: context.actor.type,
    ref: context.actor.ref,
    issuer: null,
  }
}

export const anonymousAuthzContext = (): AuthzContext => ({
  credential: 'anonymous',
  userId: null,
  grantedScopes: null,
  actor: null,
})

export const platformMiddleware = (platform: Platform, auth: Auth) =>
  createMiddleware<Env>(async (c, next) => {
    const requestId = crypto.randomUUID()
    c.set('requestId', requestId)
    c.set('platform', platform)
    c.set('auth', auth)
    c.set('principal', null)
    c.set('authzContext', anonymousAuthzContext())
    c.set('errorLog', null)
    c.set('sitePublicOrigin', null)
    c.set('webDavEnabled', false)
    c.set('webDavDomain', '')
    c.set('webDavMountPath', '/dav')
    c.set('webDavTrace', [])
    c.set('webDavDownloadAuditTarget', null)
    c.set('webDavResolvedPutTarget', null)
    c.set('webDavUploadAuditTarget', null)
    c.set('webDavLocksByResource', new Map())
    try {
      await next()
    } finally {
      c.header('Request-Id', requestId)
    }
  })
