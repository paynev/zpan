import { type ApiKeyPermissions, AuthorizationScope, isAuthorizationScope, scopePermissions } from './authorization'

export type { ApiKeyPermissions } from './authorization'

/** Free-form metadata attached to an API key by Better Auth. */
export interface ApiKeyMetadata {
  [key: string]: unknown
}

export const ApiKeyTemplate = {
  WEBDAV: 'webdav',
} as const

export type ApiKeyTemplate = (typeof ApiKeyTemplate)[keyof typeof ApiKeyTemplate]

export const WEBDAV_API_KEY_RATE_LIMIT_WINDOW_MS = 60_000
export const WEBDAV_API_KEY_RATE_LIMIT_MAX_REQUESTS = 3600
export const WEBDAV_RATE_LIMITER_BINDING = 'WEBDAV_RATE_LIMITER'

export const WEBDAV_API_KEY_PERMISSIONS = scopePermissions([
  AuthorizationScope.OBJECTS_READ,
  AuthorizationScope.OBJECTS_CREATE,
  AuthorizationScope.OBJECTS_UPDATE,
  AuthorizationScope.OBJECTS_DELETE,
  AuthorizationScope.SHARES_READ,
  AuthorizationScope.STORAGE_USAGE_READ,
])

export const API_KEY_TEMPLATE_PERMISSIONS = {
  [ApiKeyTemplate.WEBDAV]: WEBDAV_API_KEY_PERMISSIONS,
} satisfies Record<ApiKeyTemplate, ApiKeyPermissions>

export const API_KEY_TEMPLATES = Object.values(ApiKeyTemplate)

const LEGACY_PERMISSION_SCOPES: Record<string, Record<string, string[]>> = {
  webdav: {
    read: [AuthorizationScope.OBJECTS_READ],
    write: [AuthorizationScope.OBJECTS_CREATE, AuthorizationScope.OBJECTS_UPDATE, AuthorizationScope.OBJECTS_DELETE],
  },
}

/** Normalize legacy resource/action permission maps into the flat scope map. */
export function canonicalizeApiKeyPermissions(input: ApiKeyPermissions): ApiKeyPermissions {
  const scopes = new Set<string>()
  for (const [resource, actions] of Object.entries(input)) {
    if (!Array.isArray(actions)) continue
    for (const action of actions) {
      if (typeof action !== 'string') continue
      const legacyScopes = LEGACY_PERMISSION_SCOPES[resource]?.[action]
      if (legacyScopes) {
        for (const scope of legacyScopes) scopes.add(scope)
        continue
      }
      const scope = `${resource}:${action}`
      // Drop permissions for features that no longer exist (remote downloads,
      // org/team management, image hosting, store, licensing, ...). This is backfill-only:
      // the runtime scope check already ignores unknown scopes.
      if (isAuthorizationScope(scope)) scopes.add(scope)
    }
  }

  const permissions: ApiKeyPermissions = {}
  for (const scope of [...scopes].sort()) {
    const separator = scope.indexOf(':')
    if (separator <= 0) continue
    const resource = scope.slice(0, separator)
    const action = scope.slice(separator + 1)
    permissions[resource] = [...(permissions[resource] ?? []), action]
  }
  return permissions
}

export function serializeApiKeyPermissions(input: ApiKeyPermissions): string {
  const sorted: Record<string, unknown> = {}
  for (const resource of Object.keys(input).sort()) {
    const actions: unknown = input[resource]
    if (!Array.isArray(actions)) {
      sorted[resource] = actions
      continue
    }
    sorted[resource] = [...new Set(actions.filter((action): action is string => typeof action === 'string'))].sort()
  }
  return JSON.stringify(sorted)
}
