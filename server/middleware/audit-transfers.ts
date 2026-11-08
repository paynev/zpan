import { DirType } from '@shared/constants'
import type { Context } from 'hono'
import type { Matter } from '../usecases/ports'
import { decodeChildRef } from '../usecases/share'
import type { TransferAuditTarget } from '../usecases/transfer-activity'
import { type AuditActor, auditActor } from './audit-actor'
import { type AuditRoute, type AuditRouteContext, auditRoute } from './audit-registry'
import type { AuthPrincipal, Env } from './platform'

const DOWNLOAD_FAILURE_STATUSES = new Set([402, 422, 500])
const UPLOAD_FAILURE_STATUSES = new Set([404, 409, 422, 500, 502])

export const TRANSFER_AUDIT_ROUTES: AuditRoute[] = [
  auditRoute(
    'POST',
    '/api/objects/:objectId/uploads/:sessionId/completions',
    uploadAction,
    {
      type: transferTargetType,
      id: async (context) => stringField(await context.response(), 'id') ?? transferTarget(context)?.targetId,
      name: async (context) => stringField(await context.response(), 'name') ?? transferTarget(context)?.targetName,
    },
    {
      statuses: (status) => status === 200 || UPLOAD_FAILURE_STATUSES.has(status),
      prepare: prepareObjectUpload,
      when: hasTransferTarget,
      metadata: uploadMetadata,
    },
  ),
  auditRoute(
    'GET',
    '/api/objects/:objectId',
    'download_failed',
    {
      type: transferTargetType,
      id: ({ resource }) => transferTargetValue(resource)?.targetId,
      name: transferTargetName,
    },
    {
      statuses: isDownloadFailureStatus,
      prepare: prepareObjectDownload,
      when: hasTransferTarget,
      metadata: downloadFailureMetadata,
    },
  ),
  auditRoute(
    'GET',
    '/api/shares/:token/objects/:childRef',
    'download_failed',
    {
      type: transferTargetType,
      id: ({ resource }) => transferTargetValue(resource)?.targetId,
      name: transferTargetName,
    },
    {
      statuses: isDownloadFailureStatus,
      prepare: prepareShareDownload,
      when: hasTransferTarget,
      metadata: downloadFailureMetadata,
    },
  ),
]

export function isDownloadFailureStatus(status: number): boolean {
  return DOWNLOAD_FAILURE_STATUSES.has(status)
}

export function transferFailureReason(c: Context<Env>): string {
  const reason = c.get('errorLog')?.reason
  if (reason) return reason.toLowerCase()
  if (c.res.status === 402) return 'insufficient_credits'
  if (c.res.status === 404) return 'not_found'
  if (c.res.status === 409) return 'invalid_state'
  if (c.res.status === 422) return 'quota_exceeded'
  if (c.res.status === 502) return 'storage_failure'
  return 'internal'
}

export function transferAuditActor(principal: AuthPrincipal | null): AuditActor {
  return auditActor(principal)
}

async function prepareObjectUpload({ c, params }: { c: Context<Env>; params: Record<string, string> }) {
  const [matter, session] = await Promise.all([
    c.get('deps').matter.get(params.objectId),
    c.get('deps').objectUploadSessions.get(params.objectId, params.sessionId),
  ])
  if (!matter || !session || session.status !== 'active') return null
  return {
    targetType: 'file',
    targetId: matter.id,
    targetName: matter.name,
    bytes: matter.size ?? 0,
    source: 'upload',
    metadata: { matterId: matter.id, storageId: matter.storageId, sessionId: params.sessionId },
  } satisfies TransferAuditTarget
}

async function prepareObjectDownload({ c, params }: { c: Context<Env>; params: Record<string, string> }) {
  return matterDownloadTarget(await c.get('deps').matter.get(params.objectId))
}

async function prepareShareDownload({ c, params }: { c: Context<Env>; params: Record<string, string> }) {
  const matterId = decodeChildRef(params.token, params.childRef)
  if (!matterId) return null
  const resolved = await c.get('deps').share.resolveByToken(params.token)
  if (resolved.status !== 'ok' || resolved.share.kind !== 'landing') return null
  const matter = await c.get('deps').matter.get(matterId)
  if (!matter || matter.trashedAt !== null || matter.dirtype !== DirType.FILE) return null
  return {
    targetType: 'share',
    targetId: resolved.share.id,
    targetName: matter.name,
    bytes: matter.size ?? 0,
    source: 'landing_share',
    metadata: { shareId: resolved.share.id, matterId: matter.id, storageId: matter.storageId },
  } satisfies TransferAuditTarget
}

function matterDownloadTarget(matter: Matter | null): TransferAuditTarget | null {
  if (!matter || matter.trashedAt !== null || matter.dirtype !== DirType.FILE || !matter.object) return null
  return {
    targetType: 'file',
    targetId: matter.id,
    targetName: matter.name,
    bytes: matter.size ?? 0,
    source: 'object_download',
    metadata: { matterId: matter.id, storageId: matter.storageId },
  }
}

function uploadAction({ c }: AuditRouteContext): string {
  return c.res.status >= 200 && c.res.status < 300 ? 'upload_confirm' : 'upload_failed'
}

function uploadMetadata(context: AuditRouteContext): Record<string, unknown> | undefined {
  const target = transferTarget(context)
  if (!target) return undefined
  const success = context.c.res.status >= 200 && context.c.res.status < 300
  return {
    ...target.metadata,
    bytes: target.bytes,
    source: target.source,
    status: success ? 'success' : 'failed',
    ...(success ? {} : { reason: transferFailureReason(context.c) }),
  }
}

function downloadFailureMetadata(context: AuditRouteContext): Record<string, unknown> | undefined {
  const target = transferTarget(context)
  if (!target) return undefined
  return {
    ...target.metadata,
    direction: 'download',
    status: 'failed',
    source: target.source,
    bytes: target.bytes,
    reason: transferFailureReason(context.c),
  }
}

function transferTarget(context: AuditRouteContext): TransferAuditTarget | null {
  return transferTargetValue(context.resource)
}

function transferTargetValue(value: unknown): TransferAuditTarget | null {
  return value && typeof value === 'object' ? (value as TransferAuditTarget) : null
}

function hasTransferTarget(context: AuditRouteContext): boolean {
  return transferTarget(context) !== null
}

function transferTargetType(context: AuditRouteContext): string {
  return transferTarget(context)?.targetType ?? 'file'
}

function transferTargetName(context: AuditRouteContext): string | undefined {
  return transferTarget(context)?.targetName
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === 'string' ? value[field] : undefined
}
