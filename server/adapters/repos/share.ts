import { DirType } from '@shared/constants'
import type { CreateShareInput } from '@shared/schemas/share'
import { and, count, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { generateId, generateShareToken } from '../../../shared/ids'
import { user } from '../../db/auth-schema'
import { matters, shareRecipients, shares } from '../../db/schema'
import { type AtomicQuery, executeWriteTransaction } from '../../db/transaction'
import { hashPassword } from '../../lib/password'
import type { Database } from '../../platform/interface'
import {
  CreateShareError,
  type Matter,
  type ShareListItem,
  type ShareRecord,
  type ShareRepo,
  type ShareResolution,
} from '../../usecases/ports'
import { resourceChangeQuery } from './resource-change'

function buildPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function folderChildrenCondition(folderPath: string) {
  const prefix = `${folderPath}/`
  // Literal prefixes avoid D1's LIKE pattern limit and preserve path case/wildcards.
  return or(eq(matters.parent, folderPath), sql`SUBSTR(${matters.parent}, 1, LENGTH(${prefix})) = ${prefix}`)
}

export function createShareRepo(db: Database): ShareRepo {
  return {
    async create(input: CreateShareInput): Promise<ShareRecord> {
      if (input.kind === 'direct' && input.password) throw new CreateShareError('DIRECT_NO_PASSWORD')
      if (input.kind === 'direct' && input.recipients && input.recipients.length > 0)
        throw new CreateShareError('DIRECT_NO_RECIPIENTS')
      const matter = await db
        .select()
        .from(matters)
        .where(and(eq(matters.id, input.matterId), isNull(matters.purgedAt)))
        .then((rows) => rows[0] ?? null)

      if (!matter) throw new CreateShareError('MATTER_NOT_FOUND')
      if (input.kind === 'direct' && matter.dirtype !== DirType.FILE) throw new CreateShareError('DIRECT_NO_FOLDER')

      const now = new Date()
      const token = generateShareToken()
      const share: ShareRecord = {
        id: generateId(),
        token,
        kind: input.kind,
        matterId: input.matterId,
        creatorId: input.creatorId,
        passwordHash: input.password ? hashPassword(input.password) : null,
        expiresAt: input.expiresAt ?? null,
        downloadLimit: input.downloadLimit ?? null,
        views: 0,
        downloads: 0,
        status: 'active',
        private: input.private ?? false,
        createdAt: now,
      }

      const queries: AtomicQuery[] = [
        db.insert(shares).values(share),
        resourceChangeQuery(db, {
          scopeType: 'site',
          scopeId: 'default',
          resourceType: 'share',
          resourceId: share.id,
          changeType: 'upsert',
          action: 'created',
          occurredAt: now,
        }),
      ]
      if (input.recipients && input.recipients.length > 0) {
        const recipientRows = input.recipients.map((r) => ({
          id: generateId(),
          shareId: share.id,
          recipientUserId: r.recipientUserId ?? null,
          recipientEmail: r.recipientEmail ?? null,
          createdAt: now,
        }))
        queries.push(db.insert(shareRecipients).values(recipientRows))
      }

      await executeWriteTransaction(db, queries)
      return share
    },

    async resolveByToken(token: string): Promise<ShareResolution> {
      const rows = await db
        .select({ share: shares, matter: matters })
        .from(shares)
        .innerJoin(matters, eq(shares.matterId, matters.id))
        .where(eq(shares.token, token))

      const row = rows[0]
      if (!row) return { status: 'not_found' }
      if (row.share.status === 'revoked') return { status: 'revoked' }

      const recipients = await db.select().from(shareRecipients).where(eq(shareRecipients.shareId, row.share.id))

      if (row.matter.trashedAt != null)
        return { status: 'matter_trashed', share: row.share, matter: row.matter, recipients }

      return { status: 'ok', share: row.share, matter: row.matter, recipients }
    },

    async incrementViews(shareId): Promise<void> {
      await db
        .update(shares)
        .set({ views: sql`${shares.views} + 1` })
        .where(eq(shares.id, shareId))
    },

    async hasDownloadsAvailable(shareId: string): Promise<boolean> {
      const nowSecs = Math.floor(Date.now() / 1000)
      const rows = await db
        .select({ id: shares.id })
        .from(shares)
        .where(
          and(
            eq(shares.id, shareId),
            eq(shares.status, 'active'),
            or(isNull(shares.downloadLimit), sql`${shares.downloads} < ${shares.downloadLimit}`),
            or(isNull(shares.expiresAt), sql`${shares.expiresAt} > ${nowSecs}`),
          ),
        )
        .limit(1)
      return rows.length === 1
    },

    async incrementDownloadsAtomic(shareId: string): Promise<{ ok: boolean; downloads: number }> {
      const nowSecs = Math.floor(Date.now() / 1000)
      const result = await db
        .update(shares)
        .set({ downloads: sql`${shares.downloads} + 1` })
        .where(
          and(
            eq(shares.id, shareId),
            eq(shares.status, 'active'),
            or(isNull(shares.downloadLimit), sql`${shares.downloads} < ${shares.downloadLimit}`),
            or(isNull(shares.expiresAt), sql`${shares.expiresAt} > ${nowSecs}`),
          ),
        )
        .returning({ downloads: shares.downloads })

      if (result.length === 1) {
        return { ok: true, downloads: result[0].downloads }
      }

      const current = await db.select({ downloads: shares.downloads }).from(shares).where(eq(shares.id, shareId))
      if (!current[0]) throw new Error('SHARE_NOT_FOUND')
      return { ok: false, downloads: current[0].downloads }
    },

    async decrementDownloads(shareId: string): Promise<void> {
      await db
        .update(shares)
        .set({ downloads: sql`CASE WHEN ${shares.downloads} > 0 THEN ${shares.downloads} - 1 ELSE 0 END` })
        .where(eq(shares.id, shareId))
    },

    async listRecipientUserIds(shareId: string): Promise<string[]> {
      const rows = await db
        .select({ userId: shareRecipients.recipientUserId })
        .from(shareRecipients)
        .where(and(eq(shareRecipients.shareId, shareId), isNotNull(shareRecipients.recipientUserId)))

      return rows.map((r) => r.userId as string)
    },

    async revokeByMatter(matterId: string): Promise<void> {
      await db.update(shares).set({ status: 'revoked' }).where(eq(shares.matterId, matterId))
    },

    async revokeByToken(token: string, creatorId: string): Promise<boolean> {
      const existing = await db
        .select({ id: shares.id })
        .from(shares)
        .where(and(eq(shares.token, token), eq(shares.creatorId, creatorId)))
        .limit(1)
      if (!existing[0]) return false
      await executeWriteTransaction(db, [
        db
          .update(shares)
          .set({ status: 'revoked' })
          .where(and(eq(shares.id, existing[0].id), eq(shares.creatorId, creatorId))),
        resourceChangeQuery(db, {
          scopeType: 'site',
          scopeId: 'default',
          resourceType: 'share',
          resourceId: existing[0].id,
          changeType: 'upsert',
          action: 'revoked',
          occurredAt: new Date(),
        }),
      ])
      return true
    },

    async setPrivacy(token: string, creatorId: string, isPrivate: boolean): Promise<boolean> {
      const existing = await db
        .select({ id: shares.id })
        .from(shares)
        .where(and(eq(shares.token, token), eq(shares.creatorId, creatorId)))
        .limit(1)
      if (!existing[0]) return false
      await executeWriteTransaction(db, [
        db
          .update(shares)
          .set({ private: isPrivate })
          .where(and(eq(shares.id, existing[0].id), eq(shares.creatorId, creatorId))),
        resourceChangeQuery(db, {
          scopeType: 'site',
          scopeId: 'default',
          resourceType: 'share',
          resourceId: existing[0].id,
          changeType: 'upsert',
          action: 'privacy_changed',
          occurredAt: new Date(),
        }),
      ])
      return true
    },

    async listForApi(creatorId, opts) {
      const conditions = [eq(shares.creatorId, creatorId)]
      if (opts.status) conditions.push(eq(shares.status, opts.status))
      if (opts.after) {
        conditions.push(
          or(
            lt(shares.createdAt, opts.after.createdAt),
            and(eq(shares.createdAt, opts.after.createdAt), lt(shares.id, opts.after.id)),
          )!,
        )
      }
      const where = and(...conditions)

      const rows = await db
        .select({
          id: shares.id,
          token: shares.token,
          kind: shares.kind,
          matterId: shares.matterId,
          creatorId: shares.creatorId,
          expiresAt: shares.expiresAt,
          downloadLimit: shares.downloadLimit,
          views: shares.views,
          downloads: shares.downloads,
          status: shares.status,
          private: shares.private,
          createdAt: shares.createdAt,
          matterName: matters.name,
          matterType: matters.type,
          matterDirtype: matters.dirtype,
          recipientCount: count(shareRecipients.id),
        })
        .from(shares)
        .leftJoin(matters, eq(shares.matterId, matters.id))
        .leftJoin(shareRecipients, eq(shareRecipients.shareId, shares.id))
        .where(where)
        .groupBy(shares.id)
        .orderBy(desc(shares.createdAt), desc(shares.id))
        .limit(opts.pageSize + 1)

      const hasMore = rows.length > opts.pageSize
      const page = hasMore ? rows.slice(0, opts.pageSize) : rows
      const items: ShareListItem[] = rows.map(
        ({ matterName, matterType, matterDirtype, recipientCount, ...share }) => ({
          ...share,
          matter: { name: matterName ?? '', type: matterType ?? '', dirtype: matterDirtype ?? 0 },
          recipientCount,
        }),
      )

      const last = page.at(-1)
      return {
        items: items.slice(0, opts.pageSize),
        nextBoundary: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      }
    },

    async listReceivedForApi(userId, userEmail, opts) {
      const recipientMatch = userEmail
        ? or(eq(shareRecipients.recipientUserId, userId), eq(shareRecipients.recipientEmail, userEmail))
        : eq(shareRecipients.recipientUserId, userId)
      const cursor = opts.after
        ? or(
            lt(shares.createdAt, opts.after.createdAt),
            and(eq(shares.createdAt, opts.after.createdAt), lt(shares.id, opts.after.id)),
          )
        : undefined
      const where = and(eq(shares.status, 'active'), recipientMatch, cursor)

      const rows = await db
        .select({
          id: shares.id,
          token: shares.token,
          kind: shares.kind,
          matterId: shares.matterId,
          creatorId: shares.creatorId,
          expiresAt: shares.expiresAt,
          downloadLimit: shares.downloadLimit,
          views: shares.views,
          downloads: shares.downloads,
          status: shares.status,
          private: shares.private,
          createdAt: shares.createdAt,
          matterName: matters.name,
          matterType: matters.type,
          matterDirtype: matters.dirtype,
          creatorName: sql<string | null>`(SELECT name FROM user WHERE user.id = ${shares.creatorId})`,
        })
        .from(shares)
        .innerJoin(shareRecipients, eq(shareRecipients.shareId, shares.id))
        .leftJoin(matters, eq(shares.matterId, matters.id))
        .where(where)
        .groupBy(shares.id)
        .orderBy(desc(shares.createdAt), desc(shares.id))
        .limit(opts.pageSize + 1)

      const hasMore = rows.length > opts.pageSize
      const page = hasMore ? rows.slice(0, opts.pageSize) : rows
      const items: ShareListItem[] = rows.map(({ matterName, matterType, matterDirtype, creatorName, ...share }) => ({
        ...share,
        matter: { name: matterName ?? '', type: matterType ?? '', dirtype: matterDirtype ?? 0 },
        recipientCount: 0,
        creatorName: creatorName ?? undefined,
      }))

      const last = page.at(-1)
      return {
        items: items.slice(0, opts.pageSize),
        nextBoundary: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      }
    },

    async listDirectActiveChildren(folderPath: string): Promise<Matter[]> {
      return db
        .select()
        .from(matters)
        .where(
          and(
            eq(matters.parent, folderPath),
            eq(matters.status, 'active'),
            isNull(matters.trashedAt),
            isNull(matters.purgedAt),
          ),
        )
    },

    async getCreatorIdentity(creatorId: string) {
      const rows = await db.select({ name: user.name }).from(user).where(eq(user.id, creatorId)).limit(1)
      return rows[0] ?? null
    },

    async getUserEmail(userId: string): Promise<string | null> {
      const rows = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1)
      return rows[0]?.email ?? null
    },

    async getMatterName(matterId: string): Promise<string | null> {
      const rows = await db
        .select({ name: matters.name })
        .from(matters)
        .where(and(eq(matters.id, matterId), isNull(matters.purgedAt)))
        .limit(1)
      return rows[0]?.name ?? null
    },

    async findShareChildMatter(
      rootMatter: { id: string; parent: string; name: string },
      childId: string,
    ): Promise<Matter | null> {
      const root = buildPath(rootMatter.parent, rootMatter.name)
      const rows = await db
        .select()
        .from(matters)
        .where(
          and(
            eq(matters.id, childId),
            eq(matters.status, 'active'),
            isNull(matters.trashedAt),
            isNull(matters.purgedAt),
            folderChildrenCondition(root),
          ),
        )
      return rows[0] ?? null
    },
  }
}
