// The composition root. createDeps wires concrete adapters into the Deps object
// the rest of the server consumes. This is the ONLY place adapters are
// constructed. Keep it a cheap, request-free factory so the scheduled
// entrypoint can reuse it; request-bound capabilities are passed to usecases as
// function parameters, never stored here.

import { type CloudflareKvNamespaceLike, createCloudflareKvBackend } from './adapters/cache/cloudflare-kv'
import { createRuntimeCache, resolveCacheMode } from './adapters/cache/runtime-cache'
import { createAgentInfoGateway } from './adapters/gateways/agent-info'
import { S3Service } from './adapters/gateways/s3'
import { createChangelogProvider } from './adapters/providers/changelog'
import { createApiKeyGateway } from './adapters/repos/api-keys'
import { createAuditRepo } from './adapters/repos/audit'
import { createAuditActorDirectoryRepo } from './adapters/repos/audit-actor-directory'
import { createInstanceRepo } from './adapters/repos/instance'
import { createMatterRepo } from './adapters/repos/matter'
import { createNotificationRepo } from './adapters/repos/notification'
import { createObjectUploadSessionRepo } from './adapters/repos/object-upload-session'
import { createResourceChangeRepo } from './adapters/repos/resource-change'
import { createShareRepo } from './adapters/repos/share'
import { createStorageRepo } from './adapters/repos/storage'
import { createStorageUsageRepo } from './adapters/repos/storage-usage'
import { createSystemOptionsRepo } from './adapters/repos/system-options'
import { createWebDavPathRepo } from './adapters/repos/webdav-path'
import { createWebDavStateRepo } from './adapters/repos/webdav-state'
import type { Platform } from './platform/interface'
import type { Deps } from './usecases/deps'
import type { CacheService } from './usecases/ports'

export interface CreateDepsOptions {
  cache?: CacheService
}

export function createDeps(platform: Platform, options: CreateDepsOptions = {}): Deps {
  const { db } = platform
  // Shared stateless instances reused by multiple ports below.
  const s3 = new S3Service()
  const systemOptions = createSystemOptionsRepo(db)
  const cacheNamespace = platform.getBinding<CloudflareKvNamespaceLike>('CACHE_KV')
  const cache =
    options.cache ??
    createRuntimeCache({
      mode: resolveCacheMode(platform.getEnv('ZPAN_CACHE_MODE'), !!cacheNamespace),
      distributed: cacheNamespace ? createCloudflareKvBackend(cacheNamespace) : undefined,
    })
  const storages = createStorageRepo(db, cache)
  return {
    audit: createAuditRepo(db),
    auditActorDirectory: createAuditActorDirectoryRepo(db),
    agentInfo: createAgentInfoGateway(),
    apiKeys: createApiKeyGateway(),
    cache,
    changelog: createChangelogProvider(),
    instance: createInstanceRepo(db),
    matter: createMatterRepo(db),
    notifications: createNotificationRepo(db),
    objectUploadSessions: createObjectUploadSessionRepo(db),
    resourceChanges: createResourceChangeRepo(db),
    s3,
    share: createShareRepo(db),
    storages,
    storageUsage: createStorageUsageRepo(db),
    systemOptions,
    webdavPath: createWebDavPathRepo(db, cache),
    webdavState: createWebDavStateRepo(db),
  }
}
