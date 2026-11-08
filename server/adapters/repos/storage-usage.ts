import { DirType } from '@shared/constants'
import { eq, inArray, sql } from 'drizzle-orm'
import { matters, storages } from '../../db/schema'
import type { Database } from '../../platform/interface'
import type { StorageUsageRepo } from '../../usecases/ports'

export function createStorageUsageRepo(db: Database): StorageUsageRepo {
  return {
    async rollbackReservations(reservations) {
      const bytesByStorage = new Map<string, number>()

      for (const reservation of reservations) {
        if (!reservation || reservation.bytes <= 0) continue
        bytesByStorage.set(reservation.storageId, (bytesByStorage.get(reservation.storageId) ?? 0) + reservation.bytes)
      }

      for (const [storageId, bytes] of bytesByStorage) {
        await db
          .update(storages)
          .set({ used: sql`MAX(0, ${storages.used} - ${bytes})` })
          .where(eq(storages.id, storageId))
      }
    },

    async reconcile(storageIds = []) {
      const ids = [...storageIds]
      const usedExpression = sql`COALESCE((
        SELECT SUM(${matters.size})
        FROM ${matters}
        WHERE ${matters.storageId} = ${storages.id}
          AND ${matters.dirtype} = ${DirType.FILE}
          AND ${matters.status} = 'active'
          AND ${matters.purgedAt} IS NULL
          AND ${matters.trashedAt} IS NULL
      ), 0)`

      if (ids.length > 0) {
        await db.update(storages).set({ used: usedExpression }).where(inArray(storages.id, ids))
        return
      }

      await db.update(storages).set({ used: usedExpression })
    },
  }
}
