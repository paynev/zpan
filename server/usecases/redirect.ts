// The redirect resource usecase owns every business decision behind the
// /r/:token short-link download route. The HTTP boundary validates the token
// namespace and passes the resolved share record through download and audit
// handling.
import {
  type AppError,
  expired as expiredError,
  notFound,
  type S3Gateway,
  type ShareRepo,
  type ShareResolution,
  type StorageRepo,
  storageNotFound,
} from './ports'
import { PRESIGN_TTL_SECS } from './share'
import { createTrafficEventId, type TransferAuditTarget } from './transfer-activity'

export type RedirectDeps = {
  s3: S3Gateway
  storages: StorageRepo
  share: ShareRepo
}

export function directShareDownloadAuditTarget(resolved: ShareResolution): TransferAuditTarget | null {
  if (resolved.status === 'ok' && resolved.share.kind === 'direct') {
    return {
      targetType: 'share',
      targetId: resolved.share.id,
      targetName: resolved.matter.name,
      bytes: resolved.matter.size ?? 0,
      source: 'direct_share',
      metadata: {
        shareId: resolved.share.id,
        matterId: resolved.matter.id,
        storageId: resolved.matter.storageId,
      },
    }
  }
  return null
}

export async function resolveDirectShareRedirectTarget(
  deps: Pick<RedirectDeps, 'share'>,
  token: string,
): Promise<{ resolved: ShareResolution; auditTarget: TransferAuditTarget | null }> {
  const resolved = await deps.share.resolveByToken(token)
  return { resolved, auditTarget: directShareDownloadAuditTarget(resolved) }
}

export type DirectShareOutcome =
  | {
      ok: true
      url: string
      receipt: {
        shareId: string
        matterId: string
        matterName: string
        storageId: string
        bytes: number
        trafficEventId: string
      }
    }
  | { ok: false; error: AppError }

// Resolve a direct-share token to a presigned download URL, running the share
// gates, atomically reserving a download, and presigning. On a presign failure
// the reserved download is rolled back before the error propagates (→ 500 at the
// http layer).
export async function resolveDirectShareDownload(
  deps: RedirectDeps,
  params: { resolved: ShareResolution; now?: Date },
): Promise<DirectShareOutcome> {
  const now = params.now ?? new Date()
  const resolved = params.resolved
  if (resolved.status !== 'ok') {
    if (resolved.status === 'matter_trashed') return { ok: false, error: expiredError('File no longer available') }
    return { ok: false, error: notFound('Share not found or revoked') }
  }

  const { share, matter } = resolved
  if (share.kind !== 'direct') return { ok: false, error: notFound('Share not found or revoked') }

  if (share.expiresAt && share.expiresAt < now) return { ok: false, error: expiredError('Share has expired') }

  if (!(await deps.share.hasDownloadsAvailable(share.id)))
    return { ok: false, error: expiredError('Download limit exceeded') }

  const storage = await deps.storages.get(matter.storageId)
  if (!storage) return { ok: false, error: storageNotFound() }

  const { ok } = await deps.share.incrementDownloadsAtomic(share.id)
  if (!ok) return { ok: false, error: expiredError('Download limit exceeded') }

  const bytes = matter.size ?? 0
  const trafficEventId = createTrafficEventId()

  let url: string
  try {
    url = await deps.s3.presignDownload(storage, matter.object, matter.name, PRESIGN_TTL_SECS)
  } catch (e) {
    await deps.share.decrementDownloads(share.id)
    throw e
  }

  return {
    ok: true,
    url,
    receipt: {
      shareId: share.id,
      matterId: matter.id,
      matterName: matter.name,
      storageId: storage.id,
      bytes,
      trafficEventId,
    },
  }
}
