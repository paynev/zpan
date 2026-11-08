import { inArray } from 'drizzle-orm'
import { apikey, user } from '../../db/auth-schema'
import type { Database } from '../../platform/interface'
import type { AuditActorDirectory } from '../../usecases/ports'

export function createAuditActorDirectoryRepo(db: Database): AuditActorDirectory {
  return {
    async findUserProfiles(userIds) {
      const uniqueIds = [...new Set(userIds)]
      if (uniqueIds.length === 0) return new Map()
      const rows = await db
        .select({ id: user.id, name: user.name, image: user.image })
        .from(user)
        .where(inArray(user.id, uniqueIds))
      return new Map(
        rows.map(
          (row) =>
            [
              row.id,
              {
                name: row.name || row.id,
                image: row.image,
                resolved: true,
              },
            ] as const,
        ),
      )
    },

    async findApiKeyNames(keyIds) {
      const uniqueIds = [...new Set(keyIds)]
      if (uniqueIds.length === 0) return new Map()
      const rows = await db
        .select({ id: apikey.id, name: apikey.name })
        .from(apikey)
        .where(inArray(apikey.id, uniqueIds))
      return new Map(rows.flatMap((row) => (row.name ? [[row.id, row.name] as const] : [])))
    },
  }
}
