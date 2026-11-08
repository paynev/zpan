import { DirType } from '@shared/constants'
import type { Context } from 'hono'
import type { Matter, ShareResolution } from '../usecases/ports'
import {
  type AuditRoute,
  type AuditRouteContext,
  auditRoute,
  defineAuditRoutes,
  firstValue,
  param,
  preparedExists,
  preparedValue,
  responseValue,
  stringValue,
} from './audit-registry'
import { TRANSFER_AUDIT_ROUTES } from './audit-transfers'
import type { Env } from './platform'

const STANDARD_AUDIT_ROUTES: AuditRoute[] = [
  auditRoute('POST', '/api/objects', createObjectAction, responseObjectTarget(), { when: hasResponseObject }),
  auditRoute('PATCH', '/api/objects/:objectId', 'object_update', preparedMatterTarget(), {
    prepare: prepareMatter,
    when: preparedExists,
  }),
  auditRoute('DELETE', '/api/objects/:objectId', 'delete', preparedMatterTarget(), {
    prepare: prepareMatter,
    when: preparedExists,
  }),
  auditRoute('POST', '/api/objects/:objectId/copies', 'object_copy', responseObjectTarget(), {
    prepare: prepareMatter,
    when: preparedExists,
    metadata: {
      sourceId: stringValue(preparedValue('id')),
      sourceName: stringValue(preparedValue('name')),
      targetParent: stringValue(responseValue('parent')),
    },
  }),
  auditRoute('POST', '/api/trash/objects/:objectId/restorations', 'restore', preparedMatterTarget(), {
    prepare: prepareMatter,
    when: preparedExists,
  }),
  auditRoute('DELETE', '/api/trash/objects/:objectId', 'object_purge', preparedMatterTarget(), {
    prepare: prepareMatter,
    when: preparedExists,
  }),
  auditRoute('POST', '/api/shares/:token/objects', 'save_from_share', preparedShareTarget(), {
    prepare: prepareShare,
    when: hasResolvedShare,
    metadata: saveFromShareMetadata,
  }),
  responseResourceRoute('POST', '/api/site/storages', 'storage_create', 'storage', 'bucket'),
  responseResourceRoute('PUT', '/api/site/storages/:storageId', 'storage_update', 'storage', 'bucket', 'storageId'),
  responseResourceRoute('PATCH', '/api/site/storages/:storageId', 'storage_update', 'storage', 'bucket', 'storageId'),
  auditRoute(
    'DELETE',
    '/api/site/storages/:storageId',
    'storage_delete',
    {
      type: 'storage',
      id: param('storageId'),
      name: firstValue(stringValue(preparedValue('bucket')), param('storageId')),
    },
    { prepare: prepareStorage },
  ),
  staticResourceRoute('PUT', '/api/site/settings/branding', 'branding_update', 'branding', 'branding'),
  auditRoute(
    'DELETE',
    '/api/site/settings/branding/:field',
    'branding_reset',
    { type: 'branding', id: param('field'), name: param('field') },
    { metadata: { field: param('field') } },
  ),
  ...siteSettingsRoutes(),
  auditRoute('DELETE', '/api/objects/:objectId/uploads/:sessionId', 'upload_cancel', preparedMatterTarget(), {
    prepare: prepareMatter,
    when: preparedExists,
    metadata: {
      bytes: ({ resource }: AuditRouteContext) => matterResource(resource)?.size ?? 0,
      source: 'upload',
      status: 'canceled',
      reason: 'upload_canceled',
    },
  }),
  auditRoute('POST', '/api/shares', 'share_create', preparedShareTarget(), {
    resolve: resolveCreatedShare,
    when: hasResolvedShare,
    metadata: {
      kind: firstValue(stringValue(responseValue('kind')), stringValue(requestField('kind'))),
      hasPassword: async (context: AuditRouteContext) => Boolean(await context.requestValue('password')),
      hasExpiry: async (context: AuditRouteContext) => Boolean(await context.requestValue('expiresAt')),
    },
  }),
  auditRoute('PUT', '/api/shares/:token/status', 'share_revoke', preparedShareTarget(), {
    prepare: prepareShare,
    when: hasResolvedShare,
  }),
]

export const AUDIT_ROUTES = defineAuditRoutes(STANDARD_AUDIT_ROUTES, TRANSFER_AUDIT_ROUTES)

function responseResourceRoute(
  method: string,
  path: string,
  action: string,
  targetType: string,
  nameField = 'name',
  fallbackIdParam?: string,
): AuditRoute {
  const fallbackId = fallbackIdParam ? param(fallbackIdParam) : undefined
  return auditRoute(method, path, action, {
    type: targetType,
    id: fallbackId ? firstValue(stringValue(responseValue('id')), fallbackId) : stringValue(responseValue('id')),
    name: fallbackId
      ? firstValue(stringValue(responseValue(nameField)), fallbackId)
      : stringValue(responseValue(nameField)),
  })
}

function staticResourceRoute(
  method: string,
  path: string,
  action: string,
  targetType: string,
  targetName: string,
  options: Parameters<typeof auditRoute>[4] = {},
): AuditRoute {
  return auditRoute(method, path, action, { type: targetType, name: targetName }, options)
}

function siteSettingsRoutes(): AuditRoute[] {
  return [
    ['PUT', 'identity', 'site_identity_update'],
    ['PUT', 'webdav', 'site_webdav_update'],
    ['POST', 'webdav/verifications', 'site_webdav_verify'],
    ['PUT', 'email', 'site_email_update'],
  ].map(([method, path, action]) =>
    staticResourceRoute(method, `/api/site/settings/${path}`, action, 'site_settings', action),
  )
}

function responseObjectTarget() {
  return {
    type: async (context: AuditRouteContext) =>
      (await context.responseValue('dirtype')) === DirType.FILE ? 'file' : 'folder',
    id: stringValue(responseValue('id')),
    name: firstValue(stringValue(responseValue('name')), stringValue(responseValue('id'))),
  }
}

function preparedMatterTarget() {
  return {
    type: ({ resource }: AuditRouteContext) => (matterResource(resource)?.dirtype === DirType.FILE ? 'file' : 'folder'),
    id: stringValue(preparedValue('id')),
    name: stringValue(preparedValue('name')),
  }
}

function preparedShareTarget() {
  return {
    type: 'share',
    id: ({ resource }: AuditRouteContext) => resolvedShare(resource)?.share.id,
    name: ({ resource }: AuditRouteContext) => resolvedShare(resource)?.matter.name,
  }
}

async function prepareMatter({ c, params }: { c: Context<Env>; params: Record<string, string> }) {
  return c.get('deps').matter.get(params.objectId)
}

async function prepareStorage({ c, params }: { c: Context<Env>; params: Record<string, string> }) {
  return c.get('deps').storages.get(params.storageId)
}

async function prepareShare({ c, params }: { c: Context<Env>; params: Record<string, string> }) {
  return c.get('deps').share.resolveByToken(params.token)
}

async function resolveCreatedShare(context: AuditRouteContext): Promise<ShareResolution | null> {
  const token = await context.responseValue('token')
  return typeof token === 'string' ? context.c.get('deps').share.resolveByToken(token) : null
}

function createObjectAction(context: AuditRouteContext): Promise<string | null> {
  return context.responseValue('upload').then((upload) => (upload ? null : 'create'))
}

async function hasResponseObject(context: AuditRouteContext): Promise<boolean> {
  return typeof (await context.responseValue('id')) === 'string'
}

async function saveFromShareMetadata(context: AuditRouteContext): Promise<Record<string, unknown>> {
  const [request, response] = await Promise.all([context.request(), context.response()])
  const resolution = resolvedShare(context.resource)
  const saved = arrayField(response, 'saved')
  return {
    shareId: resolution?.share.id,
    sourceMatterId: resolution?.matter.id,
    targetParent: stringField(request, 'targetParent'),
    savedCount: saved.length,
    skippedCount: arrayField(response, 'skipped').length,
    bytes: saved.reduce<number>((total, item) => total + (numberField(objectValue(item), 'size') ?? 0), 0),
  }
}

function requestField(path: string) {
  return (context: AuditRouteContext) => context.requestValue(path)
}

function hasResolvedShare({ resource }: AuditRouteContext): boolean {
  return resolvedShare(resource) !== null
}

function resolvedShare(value: unknown): Extract<ShareResolution, { status: 'ok' }> | null {
  if (!value || typeof value !== 'object') return null
  const resolution = value as ShareResolution
  return resolution.status === 'ok' ? resolution : null
}

function matterResource(value: unknown): Matter | null {
  return value && typeof value === 'object' ? (value as Matter) : null
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === 'string' ? value[field] : undefined
}

function numberField(value: Record<string, unknown>, field: string): number | undefined {
  return typeof value[field] === 'number' ? value[field] : undefined
}

function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  return Array.isArray(value[field]) ? value[field] : []
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
