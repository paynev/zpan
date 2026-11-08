import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { webdavLocks } from '../../db/schema'
import { createCloudflarePlatform } from '../../platform/cloudflare'
import { createWebDavStateRepo } from './webdav-state'

function buildRepo() {
  const db = createCloudflarePlatform(env).db
  return { db, repo: createWebDavStateRepo(db) }
}

describe('[CF] WebDAV locks on D1', () => {
  it('matches depth-infinity lock scopes without D1 dynamic LIKE expressions', async () => {
    const { repo } = buildRepo()
    const parent = await repo.createLock({
      resourcePath: 'Folder',
      owner: 'tester',
      depth: 'infinity',
      timeoutSeconds: 3600,
    })
    await repo.createLock({
      resourcePath: 'Other',
      owner: 'tester',
      depth: '0',
      timeoutSeconds: 3600,
    })

    expect((await repo.activeLocks('Folder/child.txt')).map((lock) => lock.id)).toEqual([parent.id])
    expect((await repo.conflictingLocks('Folder')).map((lock) => lock.id)).toEqual([parent.id])
    expect(await repo.refreshLock('Folder/child.txt', parent.token, 3600)).toMatchObject({ id: parent.id })
    expect(await repo.removeLock('Folder/child.txt', parent.token)).toBe(true)
    expect(await repo.activeLocks('Folder/child.txt')).toEqual([])
  })

  it('filters expired locks on reads and removes them during scheduled cleanup [spec: webdav/lock-unlock]', async () => {
    const { db, repo } = buildRepo()
    const expired = await repo.createLock({
      resourcePath: 'expired.txt',
      owner: 'tester',
      depth: '0',
      timeoutSeconds: -1,
    })

    expect(await repo.activeLocks('expired.txt')).toEqual([])
    expect(await db.select().from(webdavLocks).where(eq(webdavLocks.id, expired.id))).toHaveLength(1)

    await repo.purgeExpiredLocks()

    expect(await db.select().from(webdavLocks).where(eq(webdavLocks.id, expired.id))).toHaveLength(0)
  })

  it('atomically rejects conflicting lock creation [spec: webdav/lock-preconditions]', async () => {
    const { repo } = buildRepo()
    const input = {
      resourcePath: 'Folder/file.txt',
      owner: 'tester',
      depth: '0',
      timeoutSeconds: 3600,
    }

    const attempts = await Promise.all([repo.tryCreateLock(input), repo.tryCreateLock(input)])

    expect(attempts.filter(Boolean)).toHaveLength(1)
    expect(await repo.activeLocks(input.resourcePath)).toHaveLength(1)
  })

  it('refreshes and removes a lock only when it applies to the request path [spec: webdav/lock-unlock]', async () => {
    const { repo } = buildRepo()
    const lock = await repo.createLock({
      resourcePath: 'Folder',
      owner: 'tester',
      depth: '0',
      timeoutSeconds: 3600,
    })

    expect(await repo.refreshLock('Folder/child.txt', lock.token, 3600)).toBeNull()
    expect(await repo.removeLock('Folder/child.txt', lock.token)).toBe(false)
    expect(await repo.removeLock('Folder', lock.token)).toBe(true)
  })
})
