/**
 * Playwright setup project — runs once before all device projects.
 * The webServer is already running when this executes.
 * Ensures the seeded administrator and a storage backend exist.
 */
import { expect, request as playwrightRequest, test as setup } from '@playwright/test'
import Database from 'better-sqlite3'
import { hashPassword } from '../server/lib/password'
import { generateId } from '../shared/ids'
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers'

const localBaseUrl = process.env.E2E_LOCAL_BASE_URL ?? 'http://localhost:5185'
const publicBaseUrl = process.env.E2E_PUBLIC_BASE_URL ?? process.env.E2E_BASE_URL ?? localBaseUrl

const storageConfig = {
  bucket: process.env.E2E_STORAGE_BUCKET ?? 'e2e-test',
  endpoint: process.env.E2E_STORAGE_ENDPOINT ?? 'https://localhost:9000',
  region: process.env.E2E_STORAGE_REGION ?? 'auto',
  accessKey: process.env.E2E_STORAGE_ACCESS_KEY ?? 'e2e-access-key',
  secretKey: process.env.E2E_STORAGE_SECRET_KEY ?? 'e2e-secret-key',
  capacity: 0,
  enabled: true,
}

type StorageItem = {
  id: string
  capacity: number
  used: number
  enabled: boolean
}

function isAvailableStorage(storage: StorageItem) {
  return storage.enabled && (storage.capacity === 0 || storage.used < storage.capacity)
}

// The server seeds the admin from ZPAN_USERNAME / ZPAN_PASSWORD on first boot.
// Re-assert role and credential hash so a reused local database cannot leave
// the suite with a non-admin or stale password.
function prepareNodeDatabase() {
  if (process.env.E2E_RUNTIME === 'cf') return

  const dbPath = process.env.DATABASE_URL || './zpan.db'
  const sqlite = new Database(dbPath)
  const passwordHash = hashPassword(ADMIN_PASSWORD)

  sqlite
    .prepare(
      `
        UPDATE user
        SET role = 'admin', email_verified = 1, updated_at = CAST(unixepoch('subsecond') * 1000 AS INTEGER)
        WHERE email = ?
      `,
    )
    .run(ADMIN_EMAIL)

  sqlite
    .prepare(
      `
        UPDATE account
        SET password = ?, updated_at = CAST(unixepoch('subsecond') * 1000 AS INTEGER)
        WHERE provider_id = 'credential'
          AND user_id IN (SELECT id FROM user WHERE email = ?)
      `,
    )
    .run(passwordHash, ADMIN_EMAIL)

  sqlite.close()
}

function ensureNodeStorage() {
  if (process.env.E2E_RUNTIME === 'cf') return false

  const dbPath = process.env.DATABASE_URL || './zpan.db'
  const sqlite = new Database(dbPath)
  const storage = sqlite
    .prepare(
      `
        SELECT id, capacity, used, enabled
        FROM storages
        ORDER BY created_at ASC
        LIMIT 1
      `,
    )
    .get() as StorageItem | undefined

  if (storage) {
    sqlite
      .prepare(
        `
        UPDATE storages
          SET bucket = ?, endpoint = ?, region = ?, access_key = ?, secret_key = ?,
              capacity = ?, enabled = ?, status = 'unknown', status_reason = NULL,
              status_checked_at = NULL, updated_at = CAST(unixepoch('subsecond') * 1000 AS INTEGER)
          WHERE id = ?
        `,
      )
      .run(
        storageConfig.bucket,
        storageConfig.endpoint,
        storageConfig.region,
        storageConfig.accessKey,
        storageConfig.secretKey,
        storageConfig.capacity,
        Number(storageConfig.enabled),
        storage.id,
      )
    sqlite.close()
    return true
  }

  sqlite
    .prepare(
      `
        INSERT INTO storages (
          id, bucket, endpoint, region, access_key, secret_key,
          file_path, capacity, used, enabled, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, '', ?, 0, ?, 'unknown', CAST(unixepoch('subsecond') * 1000 AS INTEGER), CAST(unixepoch('subsecond') * 1000 AS INTEGER))
      `,
    )
    .run(
      generateId(),
      storageConfig.bucket,
      storageConfig.endpoint,
      storageConfig.region,
      storageConfig.accessKey,
      storageConfig.secretKey,
      storageConfig.capacity,
      Number(storageConfig.enabled),
    )
  sqlite.close()
  return true
}

setup('seed admin and storage', async () => {
  const request = await playwrightRequest.newContext({ baseURL: localBaseUrl })
  const headers = { Origin: localBaseUrl }
  try {
    await expectPublicCallbackReady()
    prepareNodeDatabase()

    const authResp = await request.post('/api/auth/sign-in/email', {
      headers,
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    if (!authResp.ok()) {
      throw new Error(`could not authenticate E2E admin: ${authResp.status()} ${await authResp.text()}`)
    }

    const identityResp = await request.put('/api/site/settings/identity', {
      headers,
      data: {
        name: 'ZPan',
        description: '',
        publicUrl: publicBaseUrl,
      },
    })
    if (!identityResp.ok()) throw new Error(`could not set E2E public URL: ${identityResp.status()}`)

    if (ensureNodeStorage()) return

    const list = await request.get('/api/site/storages', { headers })
    if (list.ok()) {
      const data = (await list.json()) as { items?: StorageItem[] }
      const storages = data.items ?? []
      if (storages.some(isAvailableStorage)) return

      const existing = storages[0]
      if (existing) {
        const resp = await request.patch(`/api/site/storages/${existing.id}`, {
          headers,
          data: storageConfig,
        })
        if (!resp.ok()) throw new Error(`could not update E2E storage: ${resp.status()}`)
        return
      }
    }

    const storageResp = await request.post('/api/site/storages', {
      headers,
      data: storageConfig,
    })
    if (!storageResp.ok()) throw new Error(`could not create E2E storage: ${storageResp.status()}`)
  } finally {
    await request.dispose()
  }
})

async function expectPublicCallbackReady() {
  if (publicBaseUrl === localBaseUrl) return
  const request = await playwrightRequest.newContext({ baseURL: publicBaseUrl })
  try {
    await expect
      .poll(
        async () => {
          const response = await request.get('/api/health')
          return response.ok() ? ((await response.json()) as { status?: string }).status : await response.text()
        },
        { message: `public callback URL did not become ready: ${publicBaseUrl}`, timeout: 60_000 },
      )
      .toBe('ok')
  } finally {
    await request.dispose()
  }
}
