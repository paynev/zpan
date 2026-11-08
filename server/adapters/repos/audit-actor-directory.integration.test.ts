import { describe, expect, it } from 'vitest'
import { apikey, user } from '../../db/auth-schema'
import { createTestApp } from '../../test/setup'
import { createAuditActorDirectoryRepo } from './audit-actor-directory'

describe('audit actor directory repository', () => {
  it('resolves user display profiles in one local lookup [spec: audit/actor-info]', async () => {
    const { db } = await createTestApp()
    await db.insert(user).values({
      id: 'user-profile-1',
      name: 'Amber',
      email: 'amber-profile@example.com',
      image: 'https://example.com/amber.png',
    })
    const directory = createAuditActorDirectoryRepo(db)

    await expect(directory.findUserProfiles(['user-profile-1', 'missing'])).resolves.toEqual(
      new Map([['user-profile-1', { name: 'Amber', image: 'https://example.com/amber.png', resolved: true }]]),
    )
  })

  it('falls back to the user id when a user has no profile name', async () => {
    const { db } = await createTestApp()
    await db.insert(user).values({
      id: 'username-only-profile',
      name: '',
      email: 'username-only@example.com',
    })
    const directory = createAuditActorDirectoryRepo(db)

    await expect(directory.findUserProfiles(['username-only-profile'])).resolves.toEqual(
      new Map([['username-only-profile', { name: 'username-only-profile', image: null, resolved: true }]]),
    )
  })

  it('resolves API key names in one local lookup', async () => {
    const { db } = await createTestApp()
    await db.insert(apikey).values({
      id: 'key-1',
      configId: 'webdav',
      name: 'Backup key',
      referenceId: 'user-1',
      key: 'hashed-secret',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
    const directory = createAuditActorDirectoryRepo(db)

    await expect(directory.findApiKeyNames(['key-1', 'missing'])).resolves.toEqual(new Map([['key-1', 'Backup key']]))
  })

  it('skips database queries for empty identity lists', async () => {
    const { db } = await createTestApp()
    const directory = createAuditActorDirectoryRepo(db)

    await expect(directory.findApiKeyNames([])).resolves.toEqual(new Map())
    await expect(directory.findUserProfiles([])).resolves.toEqual(new Map())
  })
})
