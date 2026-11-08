import type { DavDeadProperty, DavLock, DavPropertyName } from '../../domain/webdav'

export type { DavDeadProperty, DavLock, DavPropertyName } from '../../domain/webdav'

export type DeadPropertyUpdate =
  | { action: 'set'; property: DavDeadProperty }
  | { action: 'remove'; property: DavPropertyName }

export interface CreateLockInput {
  resourcePath: string
  owner: string
  depth: string
  timeoutSeconds: number
}

// WebDAV lock + dead-property state. Reads exclude expired locks; scheduled
// cleanup removes their rows.
export interface WebDavStateRepo {
  listDeadPropertiesForResources(resourcePaths: string[]): Promise<Map<string, DavDeadProperty[]>>
  applyDeadPropertyUpdate(resourcePath: string, operations: DeadPropertyUpdate[]): Promise<void>
  copyDeadProperties(sourcePath: string, targetPath: string): Promise<void>
  deleteWebDavState(resourcePath: string): Promise<void>
  moveWebDavState(oldPath: string, newPath: string): Promise<void>
  activeLocks(resourcePath: string): Promise<DavLock[]>
  activeLocksForResources(resourcePaths: string[]): Promise<Map<string, DavLock[]>>
  conflictingLocks(resourcePath: string): Promise<DavLock[]>
  createLock(input: CreateLockInput): Promise<DavLock>
  tryCreateLock(input: CreateLockInput): Promise<DavLock | null>
  refreshLock(resourcePath: string, token: string, timeoutSeconds: number): Promise<DavLock | null>
  removeLock(resourcePath: string, token: string): Promise<boolean>
  purgeExpiredLocks(now?: number): Promise<void>
}
