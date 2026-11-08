import { DirType, ObjectStatus } from '@shared/constants'
import type { SQL } from 'drizzle-orm'
import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { generateId, generateToken } from '../../../shared/ids'
import { matters, storages } from '../../db/schema'
import { type AtomicQuery, executeWriteTransaction, executeWriteTransactionWithResults } from '../../db/transaction'
import { suggestRenamed } from '../../domain/matter-name-conflict'
import type { Database } from '../../platform/interface'
import type {
  ConflictPlan,
  ConflictResolveOptions,
  ConflictStrategy,
  CopyMatterOptions,
  CreateMatterInput,
  Matter,
  MatterListFilters,
  MatterListResult,
  MatterRepo,
  UpdateMatterInput,
} from '../../usecases/ports'
import { NameConflictError } from '../../usecases/ports'
import { resourceChangeQuery } from './resource-change'

type MatterRow = typeof matters.$inferSelect

// The single site-level resource-change scope every write emits into (SSE is a
// single global stream on this single-user instance).
const SITE_SCOPE = { scopeType: 'site' as const, scopeId: 'default' }

function toMatter(row: MatterRow): Matter {
  return row
}

function buildPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function descendantParentCondition(folderPath: string): SQL {
  const prefix = `${folderPath}/`
  return sql`SUBSTR(${matters.parent}, 1, LENGTH(${prefix})) = ${prefix}`
}

function typeFilterCondition(typeFilter: string): SQL | undefined {
  switch (typeFilter) {
    case 'folder':
      return ne(matters.dirtype, DirType.FILE)
    case 'photos':
      return like(matters.type, 'image/%')
    case 'videos':
      return like(matters.type, 'video/%')
    case 'music':
      return like(matters.type, 'audio/%')
    case 'documents':
      return or(
        like(matters.type, 'application/pdf'),
        like(matters.type, 'application/msword'),
        like(matters.type, 'application/vnd.%'),
        like(matters.type, 'text/%'),
      )
    default:
      return undefined
  }
}

// Recomputes storages.used from the live matters inventory.
// Mirrors the storage-usage repo's reconcile expression.
function reconcileStoragesUsed(db: Database, storageIds: string[]): AtomicQuery | null {
  if (storageIds.length === 0) return null
  const usedExpression = sql`COALESCE((
    SELECT SUM(${matters.size})
    FROM ${matters}
    WHERE ${matters.storageId} = ${storages.id}
      AND ${matters.dirtype} = ${DirType.FILE}
      AND ${matters.status} = 'active'
      AND ${matters.purgedAt} IS NULL
      AND ${matters.trashedAt} IS NULL
  ), 0)`
  return db.update(storages).set({ used: usedExpression }).where(inArray(storages.id, storageIds))
}

export function createMatterRepo(db: Database): MatterRepo {
  const matterChanges = (ids: string[], now: Date, action: string, changeType: 'upsert' | 'delete' = 'upsert') => [
    resourceChangeQuery(db, {
      ...SITE_SCOPE,
      resourceType: 'matter',
      resourceId: ids.length === 1 ? ids[0]! : '*',
      changeType,
      action,
      metadata: ids.length === 1 ? undefined : { affectedCount: ids.length },
      occurredAt: now,
    }),
  ]

  async function getMatter(id: string): Promise<Matter | null> {
    const rows = await db
      .select()
      .from(matters)
      .where(and(eq(matters.id, id), isNull(matters.purgedAt)))
    return rows[0] ? toMatter(rows[0]) : null
  }

  function getDescendants(folderPath: string): Promise<MatterRow[]> {
    return db
      .select()
      .from(matters)
      .where(and(isNull(matters.purgedAt), descendantParentCondition(folderPath)))
  }

  function getDirectChildren(folderPath: string): Promise<MatterRow[]> {
    return db
      .select()
      .from(matters)
      .where(and(eq(matters.parent, folderPath), isNull(matters.purgedAt)))
  }

  async function cascadeParentPath(oldPath: string, newPath: string): Promise<void> {
    // Direct children: parent = oldPath → parent = newPath
    await db
      .update(matters)
      .set({ parent: newPath, updatedAt: new Date() })
      .where(and(eq(matters.parent, oldPath), isNull(matters.purgedAt)))

    // Deeper descendants: parent starts with 'oldPath/' → replace prefix.
    await db
      .update(matters)
      .set({
        parent: sql`${newPath} || SUBSTR(${matters.parent}, LENGTH(${oldPath}) + 1)`,
        updatedAt: new Date(),
      })
      .where(and(isNull(matters.purgedAt), descendantParentCondition(oldPath)))
  }

  /**
   * Finds the live sibling that would collide with `name` under `parent`.
   * Matching is case-insensitive (mirrors the DB's partial unique index on
   * LOWER(name)). Trashed rows are also status='active', so `trashedAt IS NULL`
   * keeps the recycle bin from blocking names. `excludeId` lets rename/move skip
   * the row being modified.
   */
  async function findActiveConflict(parent: string, name: string, excludeId?: string): Promise<Matter | null> {
    const conditions = [
      eq(matters.parent, parent),
      eq(matters.status, ObjectStatus.ACTIVE),
      isNull(matters.trashedAt),
      isNull(matters.purgedAt),
      sql`lower(${matters.name}) = lower(${name})`,
    ]
    if (excludeId) conditions.push(ne(matters.id, excludeId))
    const rows = await db
      .select()
      .from(matters)
      .where(and(...conditions))
      .limit(1)
    return rows[0] ? toMatter(rows[0]) : null
  }

  async function findAvailableName(parent: string, name: string, excludeId: string | undefined): Promise<string> {
    for (let i = 1; i <= 999; i++) {
      const candidate = suggestRenamed(name, i)
      const conflict = await findActiveConflict(parent, candidate, excludeId)
      if (!conflict) return candidate
    }
    throw new Error('Too many name conflicts to auto-rename')
  }

  /**
   * Build a resolution plan WITHOUT side effects. Safe to call and discard.
   *
   * Throws NameConflictError when strategy='fail' or when 'replace' is rejected
   * because the incoming or existing row is a folder (not supported in v1).
   */
  async function planConflictResolution(
    parent: string,
    name: string,
    strategy: ConflictStrategy,
    options: ConflictResolveOptions = {},
  ): Promise<ConflictPlan> {
    const existing = await findActiveConflict(parent, name, options.excludeId)
    if (!existing) return { finalName: name, toTrash: null }

    if (strategy === 'fail') {
      throw new NameConflictError(existing.name, existing.id)
    }

    if (strategy === 'replace') {
      const incomingIsFolder = options.isFolder === true
      const existingIsFolder = existing.dirtype !== DirType.FILE
      if (incomingIsFolder || existingIsFolder) {
        throw new NameConflictError(existing.name, existing.id)
      }
      return { finalName: name, toTrash: existing }
    }

    const renamed = await findAvailableName(parent, name, options.excludeId)
    return { finalName: renamed, toTrash: null }
  }

  async function trashForReplace(existing: Matter): Promise<void> {
    const now = new Date()
    await executeWriteTransaction(
      db,
      [
        db
          .update(matters)
          .set({ trashedAt: now.getTime(), updatedAt: now })
          .where(and(eq(matters.id, existing.id), isNull(matters.purgedAt))),
        ...matterChanges([existing.id], now, 'trashed', 'delete'),
        ...(existing.dirtype === DirType.FILE ? [reconcileStoragesUsed(db, [existing.storageId])] : []),
      ].filter(Boolean) as AtomicQuery[],
    )
  }

  /** Execute the side effects of a plan (trash the replaced row). */
  async function commitConflictPlan(plan: ConflictPlan): Promise<void> {
    if (plan.toTrash) {
      await trashForReplace(plan.toTrash)
    }
  }

  /**
   * Convenience for the common case: plan + commit back-to-back. Callers that
   * need to interleave checks between plan and commit should use
   * planConflictResolution / commitConflictPlan directly — see confirmUpload.
   */
  async function applyConflictResolution(
    parent: string,
    name: string,
    strategy: ConflictStrategy,
    options: ConflictResolveOptions = {},
  ): Promise<string> {
    const plan = await planConflictResolution(parent, name, strategy, options)
    await commitConflictPlan(plan)
    return plan.finalName
  }

  function collectForPurge(idOrMatter: string): Promise<Matter[] | null>
  function collectForPurge(idOrMatter: Matter): Promise<Matter[]>
  async function collectForPurge(idOrMatter: string | Matter): Promise<Matter[] | null> {
    const existing = typeof idOrMatter === 'string' ? await getMatter(idOrMatter) : idOrMatter
    if (!existing) return null

    if (existing.dirtype === DirType.FILE) return [existing]

    const path = buildPath(existing.parent, existing.name)
    const children = await getDirectChildren(path)
    const descendants = await getDescendants(path)
    return [existing, ...children.map(toMatter), ...descendants.map(toMatter)]
  }

  const repo: MatterRepo = {
    async create(input: CreateMatterInput): Promise<Matter> {
      const now = new Date()
      const isFolder = (input.dirtype ?? 0) !== DirType.FILE
      const parent = input.parent ?? ''

      // Resolve name collisions against existing active siblings BEFORE inserting —
      // for folders this prevents duplicates at creation; for files it catches the
      // conflict before the client wastes a large S3 upload.
      const plan = await planConflictResolution(parent, input.name, input.onConflict ?? 'fail', {
        isFolder,
      })
      // Overwriting the incumbent for a draft-file 'replace' is deferred to
      // confirmUpload (which purges it after the new bytes land). That keeps a
      // failed/abandoned upload from destroying the existing file. Folders,
      // active creates, and rename commit their plan immediately.
      const deferOverwrite = !isFolder && input.status === 'draft' && plan.toTrash !== null
      if (!deferOverwrite) {
        await commitConflictPlan(plan)
      }
      const finalName = plan.finalName

      const row: MatterRow = {
        id: generateId(),
        alias: generateToken(11),
        name: finalName,
        type: input.type,
        size: input.size ?? 0,
        dirtype: input.dirtype ?? 0,
        parent,
        object: input.object,
        storageId: input.storageId,
        status: input.status,
        trashedAt: null,
        purgedAt: null,
        createdByActorType: input.createdByActorType ?? null,
        createdByActorRef: input.createdByActorRef ?? null,
        createdByActorIssuer: input.createdByActorIssuer ?? null,
        createdAt: now,
        updatedAt: now,
      }

      const isBillable = row.status === ObjectStatus.ACTIVE && row.dirtype === DirType.FILE
      await executeWriteTransaction(
        db,
        [
          db.insert(matters).values(row),
          ...matterChanges([row.id], now, 'created'),
          ...(isBillable ? [reconcileStoragesUsed(db, [row.storageId])] : []),
        ].filter(Boolean) as AtomicQuery[],
      )

      return toMatter(row)
    },

    async list(filters: MatterListFilters): Promise<MatterListResult> {
      const childMatters = aliasedTable(matters, 'child')
      const folderPath = sql<string>`CASE
        WHEN ${matters.parent} = '' THEN ${matters.name}
        ELSE ${matters.parent} || '/' || ${matters.name}
      END`
      const hasFolderChildren = exists(
        db
          .select({ id: childMatters.id })
          .from(childMatters)
          .where(
            and(
              eq(childMatters.parent, folderPath),
              ne(childMatters.dirtype, DirType.FILE),
              eq(childMatters.status, ObjectStatus.ACTIVE),
              isNull(childMatters.trashedAt),
              isNull(childMatters.purgedAt),
            ),
          )
          .limit(1),
      )
      // Live objects only. Trashed rows are status='active' too, so exclude them
      // by trashedAt; the recycle bin is served by listTrashedRoots.
      const conditions = [eq(matters.status, ObjectStatus.ACTIVE), isNull(matters.trashedAt), isNull(matters.purgedAt)]
      const typeCond = filters.typeFilter ? typeFilterCondition(filters.typeFilter) : undefined
      if (filters.search) conditions.push(like(matters.name, `%${filters.search}%`))
      if (typeCond) {
        conditions.push(typeCond)
        if (filters.typeFilter !== 'folder') conditions.push(eq(matters.dirtype, DirType.FILE))
      }
      if (!filters.search && (!typeCond || filters.typeFilter === 'folder')) {
        conditions.push(eq(matters.parent, filters.parent ?? ''))
      }
      if (filters.after) {
        conditions.push(
          or(
            lt(matters.dirtype, filters.after.dirtype),
            and(
              eq(matters.dirtype, filters.after.dirtype),
              or(
                gt(matters.createdAt, filters.after.createdAt),
                and(eq(matters.createdAt, filters.after.createdAt), gt(matters.id, filters.after.id)),
              ),
            ),
          ) as SQL,
        )
      }
      const where = and(...conditions)

      const rows = await db
        .select({
          ...getTableColumns(matters),
          hasChildren: sql<number>`CASE
            WHEN ${matters.dirtype} = ${DirType.FILE} THEN 0
            ELSE ${hasFolderChildren}
          END`.as('has_children'),
        })
        .from(matters)
        .where(where)
        .orderBy(desc(matters.dirtype), asc(matters.createdAt), asc(matters.id))
        .limit(filters.pageSize + 1)

      const hasMore = rows.length > filters.pageSize
      const page = hasMore ? rows.slice(0, filters.pageSize) : rows
      const items = page.map(({ hasChildren, ...row }) => ({
        ...toMatter(row),
        hasChildren: Boolean(hasChildren),
      }))
      const last = page.at(-1)
      return {
        items,
        nextBoundary:
          hasMore && last ? { dirtype: last.dirtype ?? DirType.FILE, createdAt: last.createdAt, id: last.id } : null,
      }
    },

    get(id) {
      return getMatter(id)
    },

    async update(id, input: UpdateMatterInput): Promise<Matter | null> {
      const existing = await getMatter(id)
      if (!existing) return null

      const now = new Date()
      const requestedName = input.name ?? existing.name
      const newParent = input.parent ?? existing.parent
      const isFolder = existing.dirtype !== DirType.FILE
      const renamed = input.name && input.name !== existing.name
      const moved = input.parent !== undefined && input.parent !== existing.parent

      // Guard: reject before touching descendants. Must happen after rename/move
      // detection but before cascading path updates.
      if (isFolder && (renamed || moved)) {
        const oldPath = buildPath(existing.parent, existing.name)
        if (newParent === oldPath || newParent.startsWith(`${oldPath}/`)) {
          throw new Error('Cannot move a folder into itself or its subfolder')
        }
      }

      // Resolve name conflict in the destination parent. Excludes self so a no-op
      // rename (A → A) is allowed.
      const newName =
        renamed || moved
          ? await applyConflictResolution(newParent, requestedName, input.onConflict ?? 'fail', {
              excludeId: existing.id,
              isFolder,
            })
          : requestedName

      if (isFolder && (renamed || moved)) {
        const oldPath = buildPath(existing.parent, existing.name)
        const newPath = buildPath(newParent, newName)
        await cascadeParentPath(oldPath, newPath)
      }

      await executeWriteTransaction(db, [
        db
          .update(matters)
          .set({ name: newName, parent: newParent, updatedAt: now })
          .where(and(eq(matters.id, id), isNull(matters.purgedAt))),
        ...matterChanges([id], now, moved ? 'moved' : renamed ? 'renamed' : 'updated'),
      ])

      const updated = { ...existing, name: newName, parent: newParent, updatedAt: now }

      return updated
    },

    async copy(source, targetParent, newObject, opts: CopyMatterOptions = {}): Promise<Matter> {
      const now = new Date()
      const isFolder = source.dirtype !== DirType.FILE
      // Default to 'rename' for copy — copying "foo.pdf" into the same folder almost
      // always means "make a duplicate", so the Finder-style auto-rename is the
      // intuitive default when the caller didn't pick a strategy.
      const finalName = await applyConflictResolution(targetParent, source.name, opts.onConflict ?? 'rename', {
        isFolder,
      })

      const row: MatterRow = {
        id: generateId(),
        alias: generateToken(11),
        name: finalName,
        type: source.type,
        size: source.size,
        dirtype: source.dirtype,
        parent: targetParent,
        object: newObject,
        storageId: source.storageId,
        status: 'active',
        trashedAt: null,
        purgedAt: null,
        createdByActorType: opts.createdByActorType ?? null,
        createdByActorRef: opts.createdByActorRef ?? null,
        createdByActorIssuer: opts.createdByActorIssuer ?? null,
        createdAt: now,
        updatedAt: now,
      }

      await executeWriteTransaction(
        db,
        [
          db.insert(matters).values(row),
          ...matterChanges([row.id], now, 'copied'),
          ...(row.dirtype === DirType.FILE ? [reconcileStoragesUsed(db, [row.storageId])] : []),
        ].filter(Boolean) as AtomicQuery[],
      )

      return toMatter(row)
    },

    async cancelDraft(id): Promise<Matter | null> {
      const existing = await getMatter(id)
      if (!existing || existing.status !== 'draft') return null

      const deleted = await db
        .delete(matters)
        .where(and(eq(matters.id, id), eq(matters.status, 'draft'), isNull(matters.purgedAt)))
        .returning({ id: matters.id })
      if (deleted.length !== 1) return null

      return existing
    },

    async trash(id): Promise<Matter | null> {
      const existing = await getMatter(id)
      if (!existing) return null
      if (existing.trashedAt != null) return existing // already in trash (idempotent)
      // Only live objects can be trashed; a draft is discarded via the upload session.
      if (existing.status !== ObjectStatus.ACTIVE) return null

      const now = new Date()
      const nowTs = now.getTime()
      const allIds = [existing.id]
      const affectedStorageIds = new Set<string>()

      if (existing.dirtype !== DirType.FILE) {
        const path = buildPath(existing.parent, existing.name)
        const children = await getDirectChildren(path)
        const descendants = await getDescendants(path)
        allIds.push(...children.map((m) => m.id), ...descendants.map((m) => m.id))
      }
      if (existing.dirtype === DirType.FILE) affectedStorageIds.add(existing.storageId)
      const subtreeRows = await db
        .select({ id: matters.id, storageId: matters.storageId, dirtype: matters.dirtype })
        .from(matters)
        .where(and(inArray(matters.id, allIds), eq(matters.dirtype, DirType.FILE), isNull(matters.purgedAt)))
      for (const row of subtreeRows) affectedStorageIds.add(row.storageId)

      // Soft delete: mark trashedAt, keep status='active'. Only mark live rows so a
      // child already trashed earlier keeps its own trashedAt (and restore later).
      await executeWriteTransaction(
        db,
        [
          db
            .update(matters)
            .set({ trashedAt: nowTs, updatedAt: now })
            .where(
              and(
                inArray(matters.id, allIds),
                eq(matters.status, ObjectStatus.ACTIVE),
                isNull(matters.trashedAt),
                isNull(matters.purgedAt),
              ),
            ),
          ...matterChanges(allIds, now, 'trashed', 'delete'),
          reconcileStoragesUsed(db, [...affectedStorageIds]),
        ].filter(Boolean) as AtomicQuery[],
      )
      const trashed = { ...existing, trashedAt: nowTs, updatedAt: now }

      return trashed
    },

    async restore(id, onConflict: ConflictStrategy = 'fail'): Promise<Matter | null> {
      const existing = await getMatter(id)
      if (!existing) return null
      if (existing.trashedAt == null) return existing // not in trash → no-op

      // A same-named active item may have been created in the original parent
      // while this one sat in trash. Resolve before touching descendants so a
      // rejection doesn't leave folders half-restored.
      const isFolder = existing.dirtype !== DirType.FILE
      const finalName = await applyConflictResolution(existing.parent, existing.name, onConflict, {
        excludeId: existing.id,
        isFolder,
      })

      const now = new Date()
      const allIds = [existing.id]

      if (isFolder) {
        const path = buildPath(existing.parent, existing.name)
        const children = await getDirectChildren(path)
        const descendants = await getDescendants(path)
        allIds.push(...children.map((m) => m.id), ...descendants.map((m) => m.id))
      }
      const affectedStorageIds = new Set<string>()
      if (existing.dirtype === DirType.FILE) affectedStorageIds.add(existing.storageId)
      const subtreeRows = await db
        .select({ id: matters.id, storageId: matters.storageId, dirtype: matters.dirtype })
        .from(matters)
        .where(and(inArray(matters.id, allIds), eq(matters.dirtype, DirType.FILE), isNull(matters.purgedAt)))
      for (const row of subtreeRows) affectedStorageIds.add(row.storageId)

      // Rename + cascade parent paths BEFORE clearing trashedAt. While everything
      // is still in trash, these writes cannot violate the live-name unique index
      // (which excludes trashedAt IS NOT NULL), and no reader sees descendants with
      // stale paths in a live state.
      if (finalName !== existing.name) {
        await db
          .update(matters)
          .set({ name: finalName, updatedAt: now })
          .where(and(eq(matters.id, existing.id), isNull(matters.purgedAt)))
        if (isFolder) {
          const oldPath = buildPath(existing.parent, existing.name)
          const newPath = buildPath(existing.parent, finalName)
          await cascadeParentPath(oldPath, newPath)
        }
      }

      // Clear the trash mark on the whole subtree (status is already 'active').
      await executeWriteTransaction(
        db,
        [
          db
            .update(matters)
            .set({ trashedAt: null, updatedAt: now })
            .where(and(inArray(matters.id, allIds), isNotNull(matters.trashedAt), isNull(matters.purgedAt))),
          ...matterChanges(allIds, now, 'restored'),
          reconcileStoragesUsed(db, [...affectedStorageIds]),
        ].filter(Boolean) as AtomicQuery[],
      )

      const restored = { ...existing, name: finalName, trashedAt: null, updatedAt: now }

      return restored
    },

    collectForPurge,

    async purge(ids): Promise<void> {
      if (ids.length === 0) return
      const rows = await db
        .select()
        .from(matters)
        .where(and(inArray(matters.id, ids), isNull(matters.purgedAt)))
      if (rows.length === 0) return

      const now = new Date()
      const storageIds = new Set(
        rows
          .filter((row) => row.dirtype === DirType.FILE && row.status === ObjectStatus.ACTIVE)
          .map((row) => row.storageId),
      )
      await executeWriteTransaction(
        db,
        [
          db
            .update(matters)
            .set({
              trashedAt: sql`COALESCE(${matters.trashedAt}, ${now.getTime()})`,
              purgedAt: now.getTime(),
              updatedAt: now,
            })
            .where(
              and(
                inArray(
                  matters.id,
                  rows.map((row) => row.id),
                ),
                isNull(matters.purgedAt),
              ),
            ),
          ...matterChanges(
            rows.map((row) => row.id),
            now,
            'purged',
            'delete',
          ),
          reconcileStoragesUsed(db, [...storageIds]),
        ].filter(Boolean) as AtomicQuery[],
      )
    },

    async listActiveDescendants(parentPath): Promise<Matter[]> {
      // Exact-prefix match (SUBSTR), not LIKE — folder names can contain `_`/`%`,
      // which LIKE would treat as wildcards and over-match. Matches the rest of this repo.
      const rows = await db
        .select()
        .from(matters)
        .where(
          and(
            eq(matters.status, ObjectStatus.ACTIVE),
            isNull(matters.trashedAt),
            isNull(matters.purgedAt),
            descendantParentCondition(parentPath),
          ),
        )
      return rows.map(toMatter)
    },

    async trashByIds(ids): Promise<void> {
      if (ids.length === 0) return
      const now = new Date()
      const affectedRows = await db
        .select({ storageId: matters.storageId, dirtype: matters.dirtype })
        .from(matters)
        .where(and(inArray(matters.id, ids), eq(matters.dirtype, DirType.FILE), isNull(matters.purgedAt)))
      await executeWriteTransaction(
        db,
        [
          db
            .update(matters)
            .set({ trashedAt: now.getTime(), updatedAt: now })
            .where(and(inArray(matters.id, ids), isNull(matters.trashedAt), isNull(matters.purgedAt))),
          ...matterChanges(ids, now, 'trashed', 'delete'),
          reconcileStoragesUsed(
            db,
            affectedRows.map((row) => row.storageId),
          ),
        ].filter(Boolean) as AtomicQuery[],
      )
    },

    async restoreActiveByIds(ids): Promise<void> {
      if (ids.length === 0) return
      const now = new Date()
      const affectedRows = await db
        .select({ storageId: matters.storageId })
        .from(matters)
        .where(and(inArray(matters.id, ids), eq(matters.dirtype, DirType.FILE), isNull(matters.purgedAt)))
      await executeWriteTransaction(
        db,
        [
          db
            .update(matters)
            .set({ trashedAt: null, updatedAt: now })
            .where(and(inArray(matters.id, ids), isNotNull(matters.trashedAt), isNull(matters.purgedAt))),
          ...matterChanges(ids, now, 'restored'),
          reconcileStoragesUsed(
            db,
            affectedRows.map((row) => row.storageId),
          ),
        ].filter(Boolean) as AtomicQuery[],
      )
    },

    async touch(id): Promise<void> {
      await db
        .update(matters)
        .set({ updatedAt: new Date() })
        .where(and(eq(matters.id, id), isNull(matters.purgedAt)))
    },

    async applyUpload(matter, fields): Promise<void> {
      const now = new Date()
      const writes: AtomicQuery[] = [
        db
          .update(matters)
          .set({ type: fields.type, size: fields.size, object: fields.object, updatedAt: now })
          .where(and(eq(matters.id, matter.id), isNull(matters.purgedAt))),
        ...matterChanges([matter.id], now, 'updated'),
        reconcileStoragesUsed(db, [matter.storageId]),
      ].filter(Boolean) as AtomicQuery[]
      await executeWriteTransaction(db, writes)
    },

    async listTrashedRoots(): Promise<Matter[]> {
      const all = await db
        .select()
        .from(matters)
        .where(and(eq(matters.status, ObjectStatus.ACTIVE), isNotNull(matters.trashedAt), isNull(matters.purgedAt)))

      const trashedPaths = new Set(all.map((m) => buildPath(m.parent, m.name)))
      return all
        .filter((m) => !trashedPaths.has(m.parent))
        .sort((a, b) => {
          const aTrashedAt = a.trashedAt ?? 0
          const bTrashedAt = b.trashedAt ?? 0
          if (aTrashedAt !== bTrashedAt) return bTrashedAt - aTrashedAt
          return b.createdAt.getTime() - a.createdAt.getTime()
        })
        .map(toMatter)
    },

    async listTrashedRootPage(opts) {
      const cursor = opts.after
        ? or(
            lt(matters.trashedAt, opts.after.trashedAt),
            and(
              eq(matters.trashedAt, opts.after.trashedAt),
              or(
                lt(matters.createdAt, opts.after.createdAt),
                and(eq(matters.createdAt, opts.after.createdAt), lt(matters.id, opts.after.id)),
              ),
            ),
          )
        : undefined
      const rows = await db
        .select()
        .from(matters)
        .where(
          and(
            eq(matters.status, ObjectStatus.ACTIVE),
            isNotNull(matters.trashedAt),
            isNull(matters.purgedAt),
            sql`NOT EXISTS (
              SELECT 1
              FROM matters AS trashed_parent
              WHERE trashed_parent.status = ${ObjectStatus.ACTIVE}
                AND trashed_parent.trashed_at IS NOT NULL
                AND trashed_parent.purged_at IS NULL
                AND (
                  CASE
                    WHEN trashed_parent.parent = '' THEN trashed_parent.name
                    ELSE trashed_parent.parent || '/' || trashed_parent.name
                  END
                ) = ${matters.parent}
            )`,
            cursor,
          ),
        )
        .orderBy(desc(matters.trashedAt), desc(matters.createdAt), desc(matters.id))
        .limit(opts.pageSize + 1)

      const hasMore = rows.length > opts.pageSize
      const page = hasMore ? rows.slice(0, opts.pageSize) : rows
      const last = page.at(-1)
      return {
        items: page.map(toMatter),
        nextBoundary:
          hasMore && last && last.trashedAt !== null
            ? { trashedAt: last.trashedAt, createdAt: last.createdAt, id: last.id }
            : null,
      }
    },

    findActiveConflict(parent, name, excludeId) {
      return findActiveConflict(parent, name, excludeId)
    },

    planConflictResolution(parent, name, strategy, options) {
      return planConflictResolution(parent, name, strategy, options)
    },

    commitConflictPlan(plan) {
      return commitConflictPlan(plan)
    },

    applyConflictResolution(parent, name, strategy, options) {
      return applyConflictResolution(parent, name, strategy, options)
    },

    async activateDraft(id, finalName, type, now): Promise<boolean> {
      const existing = await getMatter(id)
      if (!existing || existing.status !== 'draft') return false
      const activateQuery = db
        .update(matters)
        .set({ name: finalName, type, status: 'active', updatedAt: now })
        .where(and(eq(matters.id, id), eq(matters.status, 'draft'), isNull(matters.purgedAt)))
        .returning({ id: matters.id })
      const writes: AtomicQuery[] = [
        activateQuery,
        ...matterChanges([id], now, 'activated'),
        reconcileStoragesUsed(db, [existing.storageId]),
      ].filter(Boolean) as AtomicQuery[]
      const results = await executeWriteTransactionWithResults(db, writes, [0])
      const updated = results[0] as { id: string }[]
      return updated.length > 0
    },
  }

  return repo
}
