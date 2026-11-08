import { CANONICAL_AUTHORIZATION_SCOPES, permissionScopes } from '@shared/authorization'
import { createMiddleware } from 'hono/factory'
import { ApiKeyRateLimitError, rateLimited } from '../usecases/ports'
import { anonymousAuthzContext, type Env } from './platform'

type SessionWithRole = {
  user: { id: string; role?: string }
}

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
  const authHeader = c.req.raw.headers.get('Authorization')

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim()
    const platform = c.get('platform')
    const deps = c.get('deps')
    let apiKey: Awaited<ReturnType<typeof deps.apiKeys.verifyApiKey>>
    try {
      apiKey = await deps.apiKeys.verifyApiKey(c.get('auth'), platform.db, token)
    } catch (error) {
      if (error instanceof ApiKeyRateLimitError) {
        throw rateLimited(
          error.message,
          error.retryAfterMs === undefined ? undefined : Math.ceil(error.retryAfterMs / 1000),
        )
      }
      throw error
    }
    if (apiKey) {
      const userId = apiKey.referenceId
      c.set('principal', {
        kind: 'api-key',
        keyId: apiKey.id,
        configId: apiKey.configId,
        userId,
        permissions: apiKey.permissions,
        authMethod: 'api-key',
      })
      c.set('authzContext', {
        credential: 'api_key',
        userId,
        grantedScopes: new Set(permissionScopes(apiKey.permissions)),
        actor: { type: 'api_key', ref: apiKey.id },
        state: { configId: apiKey.configId, enabled: true },
      })
      c.set('userId', userId)
      c.set('userRole', null)
      await next()
      return
    }
    await next()
    return
  }

  const auth = c.get('auth')
  const result = (await auth.api.getSession({ headers: c.req.raw.headers })) as SessionWithRole | null

  c.set('userId', result?.user?.id ?? null)
  c.set('userRole', result?.user?.role ?? null)

  if (result?.user?.id) {
    c.set('principal', {
      kind: 'user',
      userId: result.user.id,
      role: result.user.role,
      authMethod: 'cookie',
    })
    c.set('authzContext', {
      credential: 'session',
      userId: result.user.id,
      grantedScopes: new Set(CANONICAL_AUTHORIZATION_SCOPES),
      actor: { type: 'user', ref: result.user.id },
      state: { firstParty: true, role: result.user.role },
    })
  } else {
    c.set('principal', null)
    c.set('authzContext', anonymousAuthzContext())
  }

  await next()
})
