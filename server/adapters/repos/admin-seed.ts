// Single-user instance bootstrap: create the one admin account from
// ZPAN_USERNAME / ZPAN_PASSWORD environment variables on first start.
// Runs only when the user table is completely empty; every later start is a
// no-op (the auth layer also rejects any self-service sign-up).
//
// This lives in adapters/repos because it writes Better Auth tables directly.

import { count } from 'drizzle-orm'
import { generateId } from '../../../shared/ids'
import { normalizeLoginIdentifier } from '../../../shared/login-identifier'
import { account, user } from '../../db/auth-schema'
import { hashPassword } from '../../lib/password'
import type { Platform } from '../../platform/interface'

export interface AdminSeedResult {
  created: boolean
  reason?: 'missing_env' | 'already_present'
}

export async function ensureAdminSeed(platform: Platform): Promise<AdminSeedResult> {
  // ZPAN_USERNAME may be a plain username ("admin") or a full email address.
  // Both are normalised to the same lower-cased email-shaped identifier that
  // the sign-in form sends to Better Auth (which lower-cases on lookup).
  const rawUsername = platform.getEnv('ZPAN_USERNAME')?.trim()
  const password = platform.getEnv('ZPAN_PASSWORD')
  const identifier = rawUsername ? normalizeLoginIdentifier(rawUsername) : null
  if (rawUsername && !identifier) {
    console.error(
      'admin.seed.invalid_username: ZPAN_USERNAME must be a username (letters, digits, ., _, -) or a full email address',
    )
  }
  if (!identifier || !password) return { created: false, reason: 'missing_env' }
  const email = identifier.email

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
