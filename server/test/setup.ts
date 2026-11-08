import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { generateId } from '../../shared/ids'
import { createApp } from '../app'
import { createAuth } from '../auth'
import { createDeps } from '../composition'
import * as authSchema from '../db/auth-schema'
import * as schema from '../db/schema'
import type { Platform } from '../platform/interface'
import { resetSitePublicOriginCache } from '../usecases/site/public-origin'

const testPasswordProvider = {
  hash: async (password: string) => `test:${password}`,
  verify: async ({ hash, password }: { hash: string; password: string }) => hash === `test:${password}`,
}

// Lets authedHeaders reach the per-app database without changing the helper's
// call signature (dozens of integration tests call it with just the app).
type TestContext = Awaited<ReturnType<typeof createTestApp>>
const testContexts = new WeakMap<TestContext['app'], Pick<TestContext, 'db'>>()

// Mirrors server/db/auth-schema.ts (better-auth + api-key plugin tables).
const AUTH_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    role TEXT,
    banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    ban_expires INTEGER,
    last_active_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  );
  CREATE INDEX IF NOT EXISTS user_created_idx ON user(created_at);
  CREATE INDEX IF NOT EXISTS user_lastActiveAt_idx ON user(last_active_at);
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    ip_address TEXT,
    user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    impersonated_by TEXT
  );
  CREATE INDEX IF NOT EXISTS session_userId_idx ON session(user_id);
  CREATE INDEX IF NOT EXISTS session_created_idx ON session(created_at);
  CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    issuer TEXT NOT NULL DEFAULT '',
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at INTEGER,
    refresh_token_expires_at INTEGER,
    scope TEXT,
    password TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  );
  CREATE INDEX IF NOT EXISTS account_userId_idx ON account(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS account_issuer_providerAccountId_unique ON account(issuer, account_id);
  CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
  );
  CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);
  CREATE TABLE IF NOT EXISTS jwks (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    alg TEXT,
    crv TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    expires_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS apikey (
    id TEXT PRIMARY KEY,
    config_id TEXT NOT NULL DEFAULT 'default',
    name TEXT,
    start TEXT,
    reference_id TEXT NOT NULL,
    prefix TEXT,
    key TEXT NOT NULL,
    refill_interval INTEGER,
    refill_amount INTEGER,
    last_refill_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    rate_limit_enabled INTEGER NOT NULL DEFAULT 1,
    rate_limit_time_window INTEGER,
    rate_limit_max INTEGER,
    request_count INTEGER NOT NULL DEFAULT 0,
    remaining INTEGER,
    last_request INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    permissions TEXT,
    metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS apikey_config_id_idx ON apikey(config_id);
  CREATE INDEX IF NOT EXISTS apikey_reference_id_idx ON apikey(reference_id);
  CREATE INDEX IF NOT EXISTS apikey_key_idx ON apikey(key);
`

// Mirrors server/db/schema.ts (single-admin schema: no org/quota/license/
// download tables).
const APP_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS matters (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    dirtype INTEGER DEFAULT 0,
    parent TEXT NOT NULL DEFAULT '',
    object TEXT NOT NULL DEFAULT '',
    storage_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    trashed_at INTEGER,
    purged_at INTEGER,
    created_by_actor_type TEXT,
    created_by_actor_ref TEXT,
    created_by_actor_issuer TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS matters_status_dir_created_idx ON matters(status, dirtype, created_at);
  CREATE INDEX IF NOT EXISTS matters_webdav_path_idx ON matters(parent, name, status, trashed_at, purged_at);
  CREATE INDEX IF NOT EXISTS matters_webdav_children_idx ON matters(parent, status, trashed_at, purged_at, dirtype DESC, name);
  CREATE INDEX IF NOT EXISTS matters_list_page_idx ON matters(parent, status, trashed_at, purged_at, dirtype DESC, created_at, id);
  CREATE INDEX IF NOT EXISTS matters_trash_page_idx ON matters(status, purged_at, trashed_at, created_at, id);
  CREATE TABLE IF NOT EXISTS webdav_dead_properties (
    id TEXT PRIMARY KEY,
    resource_path TEXT NOT NULL,
    namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS webdav_dead_properties_resource_prop_uniq ON webdav_dead_properties(resource_path, namespace, name);
  CREATE INDEX IF NOT EXISTS webdav_dead_properties_resource_idx ON webdav_dead_properties(resource_path);
  CREATE TABLE IF NOT EXISTS webdav_locks (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    resource_path TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    depth TEXT NOT NULL DEFAULT 'infinity',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS webdav_locks_resource_idx ON webdav_locks(resource_path);
  CREATE INDEX IF NOT EXISTS webdav_locks_expires_idx ON webdav_locks(expires_at);
  CREATE TABLE IF NOT EXISTS storages (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT '',
    bucket TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT 'auto',
    access_key TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    file_path TEXT NOT NULL DEFAULT '',
    capacity INTEGER NOT NULL DEFAULT 0,
    force_path_style INTEGER NOT NULL DEFAULT 1,
    used INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'unknown',
    status_reason TEXT,
    status_checked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS system_options (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    ref_type TEXT,
    ref_id TEXT,
    metadata TEXT,
    read_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at);
  CREATE INDEX IF NOT EXISTS notifications_user_read_idx ON notifications(user_id, read_at);
  CREATE INDEX IF NOT EXISTS notifications_user_page_idx ON notifications(user_id, read_at, created_at, id);
  CREATE TABLE IF NOT EXISTS object_upload_sessions (
    id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL,
    storage_id TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    upload_id TEXT,
    part_size INTEGER NOT NULL,
    on_conflict TEXT NOT NULL DEFAULT 'fail',
    status TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS object_upload_sessions_object_idx ON object_upload_sessions(object_id);
  CREATE INDEX IF NOT EXISTS object_upload_sessions_expires_idx ON object_upload_sessions(expires_at);
  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    priority INTEGER NOT NULL DEFAULT 0,
    published_at INTEGER,
    expires_at INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS announcements_status_priority_idx ON announcements(status, priority);
  CREATE INDEX IF NOT EXISTS announcements_published_idx ON announcements(published_at);
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    event_key TEXT UNIQUE,
    user_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    target_name TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    actor_type TEXT,
    actor_ref TEXT,
    actor_issuer TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_events_user_created_idx ON audit_events(user_id, created_at);
  CREATE INDEX IF NOT EXISTS audit_events_action_created_idx ON audit_events(action, created_at);
  CREATE INDEX IF NOT EXISTS audit_events_target_created_idx ON audit_events(target_type, target_id, created_at);
  CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at);
  CREATE TABLE IF NOT EXISTS resource_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    action TEXT,
    metadata TEXT,
    occurred_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS resource_changes_scope_sequence_idx ON resource_changes(scope_type, scope_id, sequence);
  CREATE INDEX IF NOT EXISTS resource_changes_resource_sequence_idx ON resource_changes(resource_type, resource_id, sequence);
  CREATE INDEX IF NOT EXISTS resource_changes_occurred_idx ON resource_changes(occurred_at);
  CREATE TABLE IF NOT EXISTS stats_rollups_hourly (
    id TEXT PRIMARY KEY,
    bucket_start INTEGER NOT NULL,
    metric_key TEXT NOT NULL,
    dimension_key TEXT NOT NULL DEFAULT '',
    dimension_value TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    unique_count INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS stats_rollups_hourly_bucket_metric_dim_uniq ON stats_rollups_hourly(bucket_start, metric_key, dimension_key, dimension_value);
  CREATE INDEX IF NOT EXISTS stats_rollups_hourly_metric_bucket_idx ON stats_rollups_hourly(metric_key, bucket_start);
  CREATE INDEX IF NOT EXISTS stats_rollups_hourly_dimension_bucket_idx ON stats_rollups_hourly(metric_key, dimension_key, bucket_start);
  CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    matter_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    password_hash TEXT,
    expires_at INTEGER,
    download_limit INTEGER,
    views INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    private INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shares_creator_status_created_idx ON shares(creator_id, status, created_at, id);
  CREATE INDEX IF NOT EXISTS shares_creator_private_created_idx ON shares(creator_id, private, created_at);
  CREATE INDEX IF NOT EXISTS shares_created_idx ON shares(created_at);
  CREATE TABLE IF NOT EXISTS share_recipients (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    recipient_user_id TEXT,
    recipient_email TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS share_recipients_share_id_idx ON share_recipients(share_id);
  CREATE INDEX IF NOT EXISTS share_recipients_user_id_idx ON share_recipients(recipient_user_id);
  CREATE INDEX IF NOT EXISTS share_recipients_email_idx ON share_recipients(recipient_email);
`

export async function createTestApp(
  envOverrides: Record<string, string> = {},
  bindingOverrides: Record<string, unknown> = {},
  backgroundTaskHandler?: (promise: Promise<unknown>) => void,
) {
  // Each test app is a brand-new site; drop origin state cached by a previous
  // app in the same test file.
  resetSitePublicOriginCache()

  const sqlite = new Database(':memory:')
  sqlite.exec(AUTH_SCHEMA_SQL)
  sqlite.exec(APP_SCHEMA_SQL)

  const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } })
  const platform: Platform = {
    db,
    getEnv: (key: string) => envOverrides[key] ?? (key === 'BETTER_AUTH_SECRET' ? 'test-secret' : undefined),
    getBinding: <T = unknown>(key: string) => bindingOverrides[key] as T | undefined,
  }
  // Auth integration tests exercise the HTTP/database contract. The production
  // scrypt implementation has its own focused tests and would otherwise add a
  // deliberately expensive hash to every signup performed by this shared fixture.
  const auth = await createAuth(
    platform,
    'test-secret',
    'http://localhost:3000',
    undefined,
    backgroundTaskHandler,
    testPasswordProvider,
  )
  const deps = createDeps(platform)
  const app = createApp(platform, auth, deps)
  testContexts.set(app, { db })

  return { app, db, auth, platform, deps }
}

function cookieHeaders(res: Response): Record<string, string> {
  const cookies = res.headers.getSetCookie().map((cookie) => cookie.split(';')[0])
  if (cookies.length === 0) throw new Error('auth response carried no session cookie')
  return { Cookie: cookies.join('; ') }
}

export async function adminHeaders(app: ReturnType<typeof createApp>): Promise<Record<string, string>> {
  // Sign up first user (gets promoted to admin via the auth database hook)
  await authedHeaders(app, 'admin@example.com', 'password123456')
  // Sign in again to get a session that reflects the admin role
  const signInRes = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'password123456' }),
  })
  if (!signInRes.ok) throw new Error(`admin sign-in failed: ${signInRes.status}`)
  return cookieHeaders(signInRes)
}

export async function authedHeaders(
  app: ReturnType<typeof createApp>,
  email = 'test@example.com',
  password = 'password123456',
): Promise<Record<string, string>> {
  const signUpRes = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: email.split('@')[0] }),
  })
  if (signUpRes.ok) return cookieHeaders(signUpRes)

  // Single-admin instances only allow the very first account to self-register.
  // Tests that need additional actors (share recipients, bystanders) seed the
  // credential row directly, then obtain a real Better Auth session by signing
  // in through the HTTP endpoint — production sign-up stays closed.
  if (signUpRes.status !== 422) throw new Error(`sign-up failed for ${email}: ${signUpRes.status}`)
  const ctx = testContexts.get(app)
  if (!ctx) throw new Error(`no test database registered for ${email}`)
  // Better Auth looks users up by a lower-cased email. Seed the same normalized
  // form, otherwise sign-in fails for generated addresses containing capitals.
  const normalizedEmail = email.toLowerCase()
  const id = generateId()
  const now = new Date()
  await ctx.db.insert(authSchema.user).values({
    id,
    name: normalizedEmail.split('@')[0],
    email: normalizedEmail,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  })
  await ctx.db.insert(authSchema.account).values({
    id: generateId(),
    issuer: 'local:credential',
    providerAccountId: id,
    providerId: 'credential',
    userId: id,
    password: `test:${password}`,
    createdAt: now,
    updatedAt: now,
  })
  const signInRes = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: normalizedEmail, password }),
  })
  if (!signInRes.ok) throw new Error(`seeded sign-in failed for ${normalizedEmail}: ${signInRes.status}`)
  return cookieHeaders(signInRes)
}
