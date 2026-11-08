export interface AdminOverviewStorage {
  id: string
  provider: string
  bucket: string
  enabled: boolean
  status: string
  used: number
  capacity: number
  writable: boolean
}

export interface AdminOverviewStatistics {
  users: {
    total: number | null
    active30Days: number | null
    new7Days: number | null
    activity: {
      total: number | null
      today: number | null
      last7Days: number | null
      last30Days: number | null
      inactive: number | null
    }
    trend: Array<{
      date: string
      totalUsers: number | null
      activeUsers: number | null
      newUsers: number | null
    }>
  }
  storageTrend: Array<{
    date: string
    usedBytes: number | null
    writtenBytes: number | null
    releasedBytes: number | null
  }>
}

export interface AdminOverview {
  observedAt: string
  users: AdminOverviewStatistics['users']
  storages: {
    total: number
    writable: number
    used: number
    capacity: number
    unbounded: number
    trend: AdminOverviewStatistics['storageTrend']
    items: AdminOverviewStorage[]
  }
}
