import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm'
import { generateId } from '../../../shared/ids'
import { webdavDeadProperties, webdavLocks } from '../../db/schema'
import { type AtomicQuery, executeWriteTransaction } from '../../db/transaction'
import type { Database } from '../../platform/interface'
import type { DavDeadProperty, DavLock, WebDavStateRepo } from '../../usecases/ports'

export function createWebDavStateRepo(db: Database): WebDavStateRepo {
  return {
    async listDeadPropertiesForResources(resourcePaths) {
      const uniquePaths = [...new Set(resourcePaths)]
      const result = new Map(uniquePaths.map((path) => [path, [] as DavDeadProperty[]]))
      if (uniquePaths.length === 0) return result

      const rows = await db
        .select({
          resourcePath: webdavDeadProperties.resourcePath,
          namespace: webdavDeadProperties.namespace,
          name: webdavDeadProperties.name,
          value: webdavDeadProperties.value,
        })
        .from(webdavDeadProperties)
        .where(inArray(webdavDeadProperties.resourcePath, uniquePaths))

      for (const row of rows) {
        result.get(row.resourcePath)?.push({ namespace: row.namespace, name: row.name, value: row.value })
      }
      return result
    },

    async applyDeadPropertyUpdate(resourcePath, operations) {
      const now = new Date()
      const queries: AtomicQuery[] = []
      for (const operation of operations) {
        if (operation.action === 'remove') {
          queries.push(
            db
              .delete(webdavDeadProperties)
              .where(
                and(
                  eq(webdavDeadProperties.resourcePath, resourcePath),
                  eq(webdavDeadProperties.namespace, operation.property.namespace),
                  eq(webdavDeadProperties.name, operation.property.name),
                ),
              ),
          )
          continue
        }

        const property = operation.property
        queries.push(
          db
            .insert(webdavDeadProperties)
            .values({
              id: generateId(),
              resourcePath,
              namespace: property.namespace,
              name: property.name,
              value: property.value,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [webdavDeadProperties.resourcePath, webdavDeadProperties.namespace, webdavDeadProperties.name],
              set: { value: property.value, updatedAt: now },
            }),
        )
      }
      await executeWriteTransaction(db, queries)
    },

    async copyDeadProperties(sourcePath, targetPath) {
      const rows = await db.select().from(webdavDeadProperties).where(eq(webdavDeadProperties.resourcePath, sourcePath))
      if (rows.length === 0) return

      const now = new Date()
      await executeWriteTransaction(
        db,
        rows.map((row) =>
          db
            .insert(webdavDeadProperties)
            .values({
              id: generateId(),
              resourcePath: targetPath,
              namespace: row.namespace,
              name: row.name,
              value: row.value,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [webdavDeadProperties.resourcePath, webdavDeadProperties.namespace, webdavDeadProperties.name],
              set: { value: row.value, updatedAt: now },
            }),
        ),
      )
    },

    async deleteWebDavState(resourcePath) {
      await executeWriteTransaction(db, [
        db
          .delete(webdavDeadProperties)
          .where(
            or(
              eq(webdavDeadProperties.resourcePath, resourcePath),
              sql`${webdavDeadProperties.resourcePath} LIKE ${`${resourcePath}/%`}`,
            ),
          ),
        db
          .delete(webdavLocks)
          .where(
            or(
              eq(webdavLocks.resourcePath, resourcePath),
              sql`${webdavLocks.resourcePath} LIKE ${`${resourcePath}/%`}`,
            ),
          ),
      ])
    },

    async moveWebDavState(oldPath, newPath) {
      const now = new Date()
      await executeWriteTransaction(db, [
        db
          .update(webdavDeadProperties)
          .set({
            resourcePath: sql`CASE WHEN ${webdavDeadProperties.resourcePath} = ${oldPath} THEN ${newPath} ELSE ${newPath} || SUBSTR(${webdavDeadProperties.resourcePath}, ${oldPath.length + 1}) END`,
            updatedAt: now,
          })
          .where(
            or(
              eq(webdavDeadProperties.resourcePath, oldPath),
              sql`${webdavDeadProperties.resourcePath} LIKE ${`${oldPath}/%`}`,
            ),
          ),
        db
          .update(webdavLocks)
          .set({
            resourcePath: sql`CASE WHEN ${webdavLocks.resourcePath} = ${oldPath} THEN ${newPath} ELSE ${newPath} || SUBSTR(${webdavLocks.resourcePath}, ${oldPath.length + 1}) END`,
            updatedAt: now,
          })
          .where(or(eq(webdavLocks.resourcePath, oldPath), sql`${webdavLocks.resourcePath} LIKE ${`${oldPath}/%`}`)),
      ])
    },

    async activeLocks(resourcePath) {
      const now = Date.now()
      const rows = await db.select().from(webdavLocks).where(sql`${webdavLocks.expiresAt} > ${now}`)
      return rows.filter((lock) => lockAppliesToResource(lock, resourcePath))
    },

    async activeLocksForResources(resourcePaths) {
      const uniquePaths = [...new Set(resourcePaths)]
      const result = new Map(uniquePaths.map((path) => [path, [] as DavLock[]]))
      if (uniquePaths.length === 0) return result

      const now = Date.now()
      const rows = await db.select().from(webdavLocks).where(sql`${webdavLocks.expiresAt} > ${now}`)

      for (const path of uniquePaths) {
        result.set(
          path,
          rows.filter((lock) => lockAppliesToResource(lock, path)),
        )
      }
      return result
    },

    async conflictingLocks(resourcePath) {
      const now = Date.now()
      const rows = await db.select().from(webdavLocks).where(sql`${webdavLocks.expiresAt} > ${now}`)
      return rows.filter((lock) => lockConflictsWithResource(lock, resourcePath))
    },

    async createLock(input) {
      const lock = newLock(input)
      await db.insert(webdavLocks).values(lock)
      return lock
    },

    async tryCreateLock(input) {
      const lock = newLock(input)
      const conflicts = lockConflictsSql(input.resourcePath, lock.createdAt.getTime())
      const rows = await db
        .insert(webdavLocks)
        .select(
          sql`SELECT ${lock.id}, ${lock.token}, ${lock.resourcePath}, ${lock.owner}, ${lock.depth}, ${lock.expiresAt.getTime()}, ${lock.createdAt.getTime()}, ${lock.updatedAt.getTime()}
              WHERE NOT EXISTS (
                SELECT 1
                FROM ${webdavLocks}
                WHERE ${conflicts}
              )`,
        )
        .returning()
      return rows[0] ?? null
    },

    async refreshLock(resourcePath, token, timeoutSeconds) {
      const now = new Date()
      const expiresAt = new Date(now.getTime() + timeoutSeconds * 1000)
      const rows = await db
        .update(webdavLocks)
        .set({ expiresAt, updatedAt: now })
        .where(
          and(
            eq(webdavLocks.token, token),
            sql`${webdavLocks.expiresAt} > ${now.getTime()}`,
            lockAppliesSql(resourcePath),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async removeLock(resourcePath, token) {
      const rows = await db
        .delete(webdavLocks)
        .where(
          and(
            eq(webdavLocks.token, token),
            sql`${webdavLocks.expiresAt} > ${Date.now()}`,
            lockAppliesSql(resourcePath),
          ),
        )
        .returning({ id: webdavLocks.id })
      return rows.length > 0
    },

    async purgeExpiredLocks(now = Date.now()) {
      await db.delete(webdavLocks).where(sql`${webdavLocks.expiresAt} <= ${now}`)
    },
  }
}

function newLock(input: { resourcePath: string; owner: string; depth: string; timeoutSeconds: number }): DavLock {
  const now = new Date()
  return {
    id: generateId(),
    token: `opaquelocktoken:${crypto.randomUUID()}`,
    resourcePath: input.resourcePath,
    owner: input.owner,
    depth: input.depth,
    expiresAt: new Date(now.getTime() + input.timeoutSeconds * 1000),
    createdAt: now,
    updatedAt: now,
  }
}

function lockAppliesSql(resourcePath: string): SQL {
  return sql`(
    ${webdavLocks.resourcePath} = ${resourcePath}
    OR (
      ${webdavLocks.depth} = 'infinity'
      AND (
        ${webdavLocks.resourcePath} = ''
        OR substr(${resourcePath}, 1, length(${webdavLocks.resourcePath}) + 1) = ${webdavLocks.resourcePath} || '/'
      )
    )
  )`
}

function lockConflictsSql(resourcePath: string, now: number): SQL {
  return sql`${webdavLocks.expiresAt} > ${now}
    AND (
      ${lockAppliesSql(resourcePath)}
      OR (
        ${resourcePath} = ''
        AND ${webdavLocks.resourcePath} <> ''
      )
      OR substr(${webdavLocks.resourcePath}, 1, length(${resourcePath}) + 1) = ${resourcePath} || '/'
    )`
}

function lockAppliesToResource(lock: DavLock, resourcePath: string): boolean {
  if (lock.resourcePath === resourcePath) return true
  if (lock.depth !== 'infinity') return false
  if (lock.resourcePath === '') return true
  return resourcePath.startsWith(`${lock.resourcePath}/`)
}

function lockConflictsWithResource(lock: DavLock, resourcePath: string): boolean {
  if (lockAppliesToResource(lock, resourcePath)) return true
  if (resourcePath === '') return lock.resourcePath !== ''
  return lock.resourcePath.startsWith(`${resourcePath}/`)
}
