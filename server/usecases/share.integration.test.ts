import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { describe, expect, it } from 'vitest'
import * as authSchema from '../db/auth-schema.js'
import { notifications } from '../db/schema.js'
import { createTestApp } from '../test/setup.js'
import type { ShareNotificationRecipient, ShareNotificationShare } from './ports'
import { dispatchShareCreated } from './share.js'

type TestCtx = Awaited<ReturnType<typeof createTestApp>>
type TestDb = TestCtx['db']

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function insertUser(db: TestDb, overrides: Partial<{ id: string; email: string }> = {}) {
  const id = overrides.id ?? nanoid()
  const email = overrides.email ?? `${id}@example.com`
  await db.insert(authSchema.user).values({
    id,
    name: 'Test User',
    email,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  return { id, email }
}

function makeShare(overrides: Partial<ShareNotificationShare> = {}): ShareNotificationShare {
  return {
    id: overrides.id ?? nanoid(),
    token: overrides.token ?? nanoid(10),
    kind: overrides.kind ?? 'landing',
    expiresAt: overrides.expiresAt ?? null,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('dispatchShareCreated', () => {
  it('inserts a notification row when recipient has recipientUserId', async () => {
    const ctx = await createTestApp()
    const user = await insertUser(ctx.db)
    const share = makeShare()
    const recipients: ShareNotificationRecipient[] = [{ recipientUserId: user.id }]

    await dispatchShareCreated(ctx.deps, share, recipients, 'Alice', 'secret.pdf')

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.userId, user.id))
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('share_received')
    expect(rows[0].title).toContain('Alice')
    expect(rows[0].title).toContain('secret.pdf')
    expect(rows[0].refType).toBe('share')
    expect(rows[0].refId).toBe(share.id)
  })

  it('does not insert notification when recipient has only email (no userId)', async () => {
    const ctx = await createTestApp()
    const share = makeShare()
    const recipients: ShareNotificationRecipient[] = [{ recipientEmail: 'someone@example.com' }]

    await dispatchShareCreated(ctx.deps, share, recipients, 'Bob', 'file.txt')

    const rows = await ctx.db.select().from(notifications)
    expect(rows).toHaveLength(0)
  })

  it('inserts in-app notifications for all recipients that have recipientUserId', async () => {
    const ctx = await createTestApp()
    const user1 = await insertUser(ctx.db)
    const user2 = await insertUser(ctx.db)
    const share = makeShare()

    const recipients: ShareNotificationRecipient[] = [
      { recipientUserId: user1.id },
      { recipientUserId: user2.id },
      { recipientEmail: 'no-account@example.com' },
    ]

    await dispatchShareCreated(ctx.deps, share, recipients, 'Hub', 'multi.zip')

    const rows1 = await ctx.db.select().from(notifications).where(eq(notifications.userId, user1.id))
    expect(rows1).toHaveLength(1)

    const rows2 = await ctx.db.select().from(notifications).where(eq(notifications.userId, user2.id))
    expect(rows2).toHaveLength(1)

    // No notification for email-only recipient
    const allRows = await ctx.db.select().from(notifications)
    expect(allRows).toHaveLength(2)
  })

  it('uses /s/{token} URL for landing shares in notification metadata', async () => {
    const ctx = await createTestApp()
    const user = await insertUser(ctx.db)
    const share = makeShare({ kind: 'landing', token: 'abc123token' })

    await dispatchShareCreated(ctx.deps, share, [{ recipientUserId: user.id }], 'Ian', 'landing.pdf')

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.userId, user.id))
    expect(rows).toHaveLength(1)
    const metadata = JSON.parse(rows[0].metadata ?? '{}') as Record<string, unknown>
    expect(metadata.token).toBe('abc123token')
    expect(metadata.kind).toBe('landing')
  })

  it('uses /r/{token} URL for direct shares in notification metadata', async () => {
    const ctx = await createTestApp()
    const user = await insertUser(ctx.db)
    const share = makeShare({ kind: 'direct', token: 'directtoken1' })

    await dispatchShareCreated(ctx.deps, share, [{ recipientUserId: user.id }], 'Jane', 'direct.mp4')

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.userId, user.id))
    expect(rows).toHaveLength(1)
    const metadata = JSON.parse(rows[0].metadata ?? '{}') as Record<string, unknown>
    expect(metadata.kind).toBe('direct')
  })

  it('handles empty recipients array without errors', async () => {
    const ctx = await createTestApp()
    const share = makeShare()

    await expect(dispatchShareCreated(ctx.deps, share, [], 'Leo', 'empty.txt')).resolves.toBeUndefined()

    const rows = await ctx.db.select().from(notifications)
    expect(rows).toHaveLength(0)
  })
})
