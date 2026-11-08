// The Deps interface aggregates every port. Usecases take `deps` as their first
// argument and reach the outside world only through it; http routes read it from
// context (`c.get('deps')`). It is assembled in composition.ts.

import type {
  AdminStatsRepo,
  AgentInfoGateway,
  AnnouncementRepo,
  ApiKeyGateway,
  AuditActorDirectory,
  AuditRepo,
  CacheService,
  ChangelogProvider,
  InstanceRepo,
  MatterRepo,
  NotificationRepo,
  ObjectUploadSessionRepo,
  ResourceChangeRepo,
  S3Gateway,
  ShareRepo,
  StorageRepo,
  StorageUsageRepo,
  SystemOptionsRepo,
  WebDavPathRepo,
  WebDavStateRepo,
} from './ports'

export interface Deps {
  audit: AuditRepo
  auditActorDirectory: AuditActorDirectory
  agentInfo: AgentInfoGateway
  adminStats: AdminStatsRepo
  announcements: AnnouncementRepo
  apiKeys: ApiKeyGateway
  cache: CacheService
  changelog: ChangelogProvider
  instance: InstanceRepo
  matter: MatterRepo
  notifications: NotificationRepo
  objectUploadSessions: ObjectUploadSessionRepo
  resourceChanges: ResourceChangeRepo
  s3: S3Gateway
  share: ShareRepo
  storages: StorageRepo
  storageUsage: StorageUsageRepo
  systemOptions: SystemOptionsRepo
  webdavPath: WebDavPathRepo
  webdavState: WebDavStateRepo
}
