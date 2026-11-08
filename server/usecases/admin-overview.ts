import type { AdminOverview } from '@shared/types'
import { normalizeStatsRange } from './admin-stats'
import type { Deps } from './deps'

export async function getAdminOverview(deps: Deps, now = new Date()): Promise<AdminOverview> {
  const [statistics, storagePage] = await Promise.all([
    deps.adminStats.getOverviewStatistics(now, normalizeStatsRange({}, now)),
    deps.storages.list(),
  ])

  const storageItems = storagePage.items.map((storage) => ({
    id: storage.id,
    provider: storage.provider,
    bucket: storage.bucket,
    enabled: storage.enabled,
    status: storage.status,
    used: storage.used,
    capacity: storage.capacity,
    writable: storage.enabled && (storage.capacity === 0 || storage.used < storage.capacity),
  }))
  const writableStorages = storageItems.filter((storage) => storage.writable).length
  const boundedStorages = storageItems.filter((storage) => storage.capacity > 0)

  return {
    observedAt: now.toISOString(),
    users: statistics.users,
    storages: {
      total: storageItems.length,
      writable: writableStorages,
      used: storageItems.reduce((total, storage) => total + storage.used, 0),
      capacity: boundedStorages.reduce((total, storage) => total + storage.capacity, 0),
      unbounded: storageItems.length - boundedStorages.length,
      trend: statistics.storageTrend,
      items: storageItems,
    },
  }
}
