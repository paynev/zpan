import type { Context } from 'hono'
import { Hono } from 'hono'
import { LEGACY_DIRECT_SHARE_TOKEN_PATTERN, SHARE_TOKEN_PATTERN } from '../../shared/ids'
import { isDownloadFailureStatus, transferAuditActor, transferFailureReason } from '../middleware/audit-transfers'
import type { Env } from '../middleware/platform'
import { notFound } from '../usecases/ports'
import {
  type DirectShareOutcome,
  resolveDirectShareDownload,
  resolveDirectShareRedirectTarget,
} from '../usecases/redirect'
import { recordDownloadFailure, recordDownloadIssued } from '../usecases/transfer-activity'

const REDIRECT_TOKEN_PATTERN = /^([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]{1,16})?$/

function parseRedirectToken(raw: string): string {
  const token = REDIRECT_TOKEN_PATTERN.exec(raw)?.[1]
  if (!token) throw notFound()
  if (SHARE_TOKEN_PATTERN.test(token) || LEGACY_DIRECT_SHARE_TOKEN_PATTERN.test(token)) return token
  throw notFound()
}

function presignedRedirect(c: Context<Env>, url: string): Response {
  const res = c.redirect(url, 302)
  res.headers.set('Cache-Control', 'no-store')
  return res
}

async function handleDirectShare(c: Context<Env>, token: string): Promise<Response> {
  const { resolved, auditTarget } = await resolveDirectShareRedirectTarget(c.get('deps'), token)
  c.set('redirectDownloadAuditTarget', auditTarget)
  const outcome: DirectShareOutcome = await resolveDirectShareDownload(c.get('deps'), { resolved })
  if (outcome.ok) {
    await recordDownloadIssued(
      c.get('deps'),
      transferAuditActor(c.get('principal')),
      'share_download',
      {
        targetType: 'share',
        targetId: outcome.receipt.shareId,
        targetName: outcome.receipt.matterName,
        bytes: outcome.receipt.bytes,
        source: 'direct_share',
        metadata: {
          shareId: outcome.receipt.shareId,
          matterId: outcome.receipt.matterId,
          storageId: outcome.receipt.storageId,
        },
      },
      outcome.receipt.trafficEventId,
    )
    return presignedRedirect(c, outcome.url)
  }
  throw outcome.error
}

const app = new Hono<Env>()

app.use('/:token', async (c, next) => {
  c.set('redirectDownloadAuditTarget', null)
  await next()
  const target = c.get('redirectDownloadAuditTarget')
  if (!target || !isDownloadFailureStatus(c.res.status)) return
  await recordDownloadFailure(c.get('deps'), transferAuditActor(c.get('principal')), target, transferFailureReason(c))
})

app.get('/:token', async (c) => handleDirectShare(c, parseRedirectToken(c.req.param('token'))))

export default app
