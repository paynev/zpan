// Single-user instance bootstrap: create the one admin account from
// ZPAN_USERNAME / ZPAN_PASSWORD environment variables on first start.
// Runs only when the user table is completely empty; every later start is a
// no-op (the auth layer also rejects any self-service sign-up).
//
// This lives in adapters/repos because it writes Better Auth tables directly.

import { count } from 'drizzle-orm'
import { generateId } from '../../../shared/ids'
import { account, user } from '../../db/auth-schema'
import { hashPassword } from '../../lib/password'
import type { Platform } from '../../platform/interface'

export interface AdminSeedResult {
  created: boolean
  reason?: 'missing_env' | 'already_present'
}

export async function ensureAdminSeed(platform: Platform): Promise<AdminSeedResult> {
  // The login form uses an email input, so ZPAN_USERNAME is an email address.
  const email = platform.getEnv('ZPAN_USERNAME')?.trim()
  const password = platform.getEnv('ZPAN_PASSWORD')
  if (!email || !password) return { created: false, reason: 'missing_env' }

  const db = platform.db
  const [row] = await db.select({ c: count() }).from(user)
  if (!row || row.c > 0) return { created: false, reason: 'already_present' }

  const now = new Date()
  const userId = generateId()
  await db.insert(user).values({
    id: userId,
    name: 'Admin',
    email,
    emailVerified: true,
    role: 'admin',
    createdAt: now,
    updatedAt: now,
  })
  await db.insert(account).values({
    id: generateId(),
    issuer: 'local:credential',
    providerId: 'credential',
    providerAccountId: userId,
    userId,
    password: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  })
  console.log(`admin.seed.created email=${email}`)
  return { created: true }
}
