// Cloudflare Workers Builds entrypoints.
//
// Dashboard settings:
//   Build command:  pnpm workers-builds:build
//   Deploy command: pnpm workers-builds:deploy
//
// wrangler.toml omits the D1/KV resource IDs on purpose: Wrangler >= 4.45
// auto-provisions them on `wrangler deploy` and keeps them linked by name on
// later deploys. The optional ZPAN_*_ID build variables pin existing resources
// instead. Those overrides must be applied BEFORE `pnpm build`, because
// @cloudflare/vite-plugin inlines the IDs into dist/zpan/wrangler.json.
//
// Deploy order matters: `wrangler deploy` must run FIRST so the remote D1
// database exists before migrations are applied.
//
// Remote migrations are applied against the resolved database UUID, NOT the
// `DB` binding name: with auto-provisioning the config has no database_id, and
// `wrangler d1 ... DB` looks the database up by `database_name` in the API.
// If the auto-provisioned database has a different name, that lookup misses and
// no business tables are ever created (the Worker then fails on system_options).
// Resolving the UUID from `wrangler d1 list --json` removes the ambiguity.
//
// Commands:
//   build    - pin optional IDs, build, verify generated config
//   deploy   - wrangler deploy, then migrations + table check
//   migrate  - migrations + table check only (one-shot repair, no redeploy)
//   verify   - read-only inspection of remote D1 tables
//   check    - read-only local config self-check

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncCloudflareWebDav } from './cloudflare-webdav.mjs'
import { webDavOrigin } from './sync-cloudflare-webdav.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER_TOML = path.join(ROOT, 'wrangler.toml')
const GENERATED_CONFIG = path.join(ROOT, 'dist', 'zpan', 'wrangler.json')

// Only the FIRST matching block is touched: top-level bindings precede the
// [previews] block, whose IDs are deliberately left alone.
const ID_BINDINGS = [
  {
    env: 'ZPAN_D1_DATABASE_ID',
    label: 'D1 database_id',
    header: '[[d1_databases]]',
    key: 'database_id',
    required: false,
  },
  {
    env: 'ZPAN_KV_NAMESPACE_ID',
    label: 'KV id',
    header: '[[kv_namespaces]]',
    key: 'id',
    required: false,
  },
  {
    env: 'ZPAN_RATELIMIT_NAMESPACE_ID',
    label: 'ratelimit namespace_id',
    header: '[[ratelimits]]',
    key: 'namespace_id',
    required: true,
  },
]

const READINESS_SQL =
  "INSERT INTO system_options (key, value) VALUES ('webdav_verified_origin', ''), ('webdav_verified_at', ''), ('webdav_verification_error', '') ON CONFLICT(key) DO UPDATE SET value = excluded.value"

function pnpm(args) {
  console.log(`\n$ pnpm ${args.join(' ')}`)
  const windows = process.platform === 'win32'
  execFileSync(windows ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: windows,
  })
}

const WRANGLER_CLI = path.join(ROOT, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js')

// Run the repo-pinned Wrangler directly with Node. This avoids the pnpm/cmd
// shim on Windows, where shell quoting would break SQL strings containing
// spaces in --command. capture=true returns stdout (stderr stays visible).
function wrangler(args, { capture = false } = {}) {
  console.log(`\n$ wrangler ${args.join(' ')}`)
  return execFileSync(process.execPath, ['--no-warnings', WRANGLER_CLI, ...args], {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  })
}

// Wrangler may print a banner around the JSON payload (e.g. "[WARNING] ...").
// Try the whole stdout first, then each line that starts a JSON container.
function parseJson(raw) {
  const text = String(raw ?? '').trim()
  const starts = [0]
  let offset = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      starts.push(offset + (line.length - trimmed.length))
    }
    offset += line.length + 1
  }
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'))
  for (const start of starts) {
    if (end < start) continue
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      continue
    }
  }
  throw new Error(`Wrangler did not return JSON:\n${text}`)
}

function queryRows(raw) {
  const parsed = parseJson(raw)
  const entries = Array.isArray(parsed) ? parsed : (parsed.result ?? parsed.results ?? [])
  if (Array.isArray(entries) && entries[0] && Array.isArray(entries[0].results)) {
    return entries[0].results
  }
  if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' && 'name' in parsed[0]) {
    return parsed
  }
  return []
}

function listRemoteDatabases() {
  const parsed = parseJson(wrangler(['d1', 'list', '--json'], { capture: true }))
  const candidates = Array.isArray(parsed) ? parsed : (parsed.result ?? parsed.databases ?? [])
  const rows = Array.isArray(candidates) ? candidates : []
  return rows
    .filter((row) => row && (row.uuid || row.id))
    .map((row) => ({ uuid: row.uuid ?? row.id, name: row.name ?? '' }))
}

// Wrangler names an auto-provisioned D1 database `<worker>-<binding>` (e.g.
// `zpan-DB` -> `zpan-db`), while this config declares `database_name`. There is
// no portable way to read back which UUID the deployed Worker is actually bound
// to, so migrate EVERY plausible zpan database. Applying migrations is
// idempotent (d1_migrations), and the bound database gets its tables whichever
// name Wrangler picked. Pass UUIDs, never the `DB` binding: with no database_id
// in the config, a binding lookup resolves by name and can hit the wrong DB.
function resolveRemoteDatabases() {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.warn(
      '[workers-builds] CLOUDFLARE_API_TOKEN is not set. Remote D1 commands need it (with Account > D1 > Edit), or a local `wrangler login` session.',
    )
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.warn('[workers-builds] CLOUDFLARE_ACCOUNT_ID is not set; Wrangler may not be able to pick an account non-interactively.')
  }
  const databases = listRemoteDatabases()
  if (databases.length === 0) {
    throw new Error(
      'No D1 databases found on the account. `wrangler deploy` must run first to auto-provision one ' +
        '(or create it with `wrangler d1 create zpan-dba`), then run `pnpm workers-builds:migrate`.',
    )
  }
  console.log('[workers-builds] Remote D1 databases:')
  for (const database of databases) {
    console.log(`  ${database.name.padEnd(32)} ${database.uuid}`)
  }

  const source = readWrangler()
  const d1 = { header: '[[d1_databases]]' }
  // If Wrangler wrote the generated resource IDs back into dist/zpan/wrangler.json
  // after provisioning, that UUID is authoritative.
  const generatedId = existsSync(GENERATED_CONFIG)
    ? JSON.parse(readFileSync(GENERATED_CONFIG, 'utf8')).d1_databases?.find((entry) => entry.binding === 'DB')
        ?.database_id
    : undefined
  const pinnedId =
    process.env.ZPAN_D1_DATABASE_ID?.trim() ||
    topLevelId(source, { ...d1, key: 'database_id' }) ||
    generatedId
  const configuredName =
    process.env.ZPAN_D1_DATABASE_NAME?.trim() || topLevelId(source, { ...d1, key: 'database_name' })
  const workerName = source.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? 'zpan'
  const autoName = `${workerName}-DB`.toLowerCase().replaceAll('_', '-')

  const byId = pinnedId ? databases.find((database) => database.uuid === pinnedId) : undefined
  if (byId) {
    console.log(`[workers-builds] Target database (pinned ID): ${byId.name} (${byId.uuid})`)
    return [byId]
  }
  const names = [configuredName, autoName].filter(Boolean)
  const byName = databases.filter((database) => names.includes(database.name))
  const zpanLike = databases.filter((database) => /^zpan/i.test(database.name))
  const chosen = byName.length > 0 ? byName : zpanLike.length > 0 && zpanLike.length <= 5 ? zpanLike : databases.length === 1 ? databases : []
  if (chosen.length === 0) {
    throw new Error(
      `Could not decide which D1 database to migrate (looked for ${[pinnedId, ...names].filter(Boolean).join(', ')}). ` +
        'Set ZPAN_D1_DATABASE_ID to the UUID printed above, or ZPAN_D1_DATABASE_NAME to its name.',
    )
  }
  console.log(`[workers-builds] Target database(s): ${chosen.map((database) => `${database.name} (${database.uuid})`).join(', ')}`)
  return chosen
}

const REQUIRED_TABLES = ['d1_migrations', 'system_options', 'user', 'account', 'session']
const REQUIRED_TABLE_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map((name) => `'${name}'`).join(', ')}) ORDER BY name`
const ALL_TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"

function remoteTableNames(database, sql) {
  return queryRows(wrangler(['d1', 'execute', database.uuid, '--remote', '--json', '--command', sql], { capture: true }))
    .map((row) => row.name)
    .filter(Boolean)
}

function applyMigrations() {
  const databases = resolveRemoteDatabases()
  const healthy = []
  const failures = []
  for (const database of databases) {
    console.log(`\n[workers-builds] === Migrating ${database.name} (${database.uuid}) ===`)
    try {
      // No binding match means Wrangler falls back to ./migrations relative to
      // cwd (ROOT), which is this repo's migrations/ directory.
      wrangler(['d1', 'migrations', 'apply', database.uuid, '--remote'])
      const present = remoteTableNames(database, REQUIRED_TABLE_SQL)
      const missing = REQUIRED_TABLES.filter((name) => !present.includes(name))
      console.log(`[workers-builds] Core tables: ${present.join(', ') || '(none)'}`)
      if (missing.length > 0) {
        throw new Error(`missing tables: ${missing.join(', ')}`)
      }
      healthy.push(database)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[workers-builds] ${database.name} failed: ${message}`)
      failures.push(`${database.name}: ${message}`)
    }
  }
  if (healthy.length === 0) {
    throw new Error(
      `No D1 database has business tables. ${failures.join(' | ')}. ` +
        'Check the deploy log above, then run `pnpm workers-builds:verify`.',
    )
  }
  console.log(`[workers-builds] Remote D1 schema OK on ${healthy.map((database) => database.name).join(', ')}`)
  return healthy[0]
}

function verify() {
  const databases = resolveRemoteDatabases()
  let withBusinessTables = 0
  for (const database of databases) {
    console.log(`\n[workers-builds] === ${database.name} (${database.uuid}) ===`)
    const tables = remoteTableNames(database, ALL_TABLE_SQL).filter((name) => !name.startsWith('sqlite_'))
    const business = tables.filter((name) => name !== 'd1_migrations')
    console.log(`[workers-builds] Tables (${tables.length}): ${tables.join(', ') || '(none)'}`)
    if (tables.includes('d1_migrations')) {
      const rows = queryRows(
        wrangler(
          ['d1', 'execute', database.uuid, '--remote', '--json', '--command', 'SELECT count(*) AS applied FROM d1_migrations'],
          { capture: true },
        ),
      )
      console.log(`[workers-builds] Applied migrations: ${rows[0]?.applied ?? '?'}`)
    }
    if (business.length > 0) {
      withBusinessTables += 1
      console.log(`[workers-builds] Business tables present (${business.length}).`)
    } else {
      console.log('[workers-builds] NO BUSINESS TABLES in this database.')
    }
  }
  if (withBusinessTables === 0) {
    console.error('[workers-builds] NO BUSINESS TABLES anywhere. Run `pnpm workers-builds:migrate` to repair.')
    process.exitCode = 1
  }
}

function readWrangler() {
  return readFileSync(WRANGLER_TOML, 'utf8')
}

// Workers Free caps cron triggers at 5 per ACCOUNT (all Workers combined).
// `wrangler deploy` fails at the very end of a deploy when this is exceeded,
// after the Worker has already been uploaded, so catch it before deploying.
function readCronTriggers(source) {
  const line = source.match(/^\s*crons\s*=\s*\[([^\]]*)\]/m)?.[1] ?? ''
  return [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

// Returns the text of the first top-level binding block, without its header.
function topLevelBody(source, binding) {
  const start = source.indexOf(binding.header)
  if (start < 0) return null
  const bodyStart = start + binding.header.length
  const rest = source.slice(bodyStart)
  const nextSection = rest.search(/\n\[/)
  return {
    start: bodyStart,
    body: nextSection < 0 ? rest : rest.slice(0, nextSection),
  }
}

function topLevelId(source, binding) {
  const block = topLevelBody(source, binding)
  if (!block) return null
  const match = block.body.match(new RegExp(`^\\s*${binding.key}\\s*=\\s*"([^"]*)"`, 'm'))
  return match?.[1] ?? null
}

function upsertId(source, binding, value) {
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    throw new Error(`${binding.env} must be a plain ID (letters, digits, hyphens), got ${JSON.stringify(value)}`)
  }
  const block = topLevelBody(source, binding)
  if (!block) throw new Error(`Could not find ${binding.header} in wrangler.toml`)
  const linePattern = new RegExp(`^(\\s*${binding.key}\\s*=\\s*")[^"]*(")`, 'm')
  const body = linePattern.test(block.body)
    ? block.body.replace(linePattern, `$1${value}$2`)
    : block.body.replace(/\s*$/, `\n${binding.key} = "${value}"\n`)
  return source.slice(0, block.start) + body + source.slice(block.start + block.body.length)
}

function patchIds() {
  const active = ID_BINDINGS.filter((binding) => process.env[binding.env]?.trim())
  if (active.length === 0) {
    console.log('[workers-builds] Auto-provisioning mode: no ZPAN_*_ID overrides set.')
    console.log('[workers-builds] Wrangler will create DB / CACHE_KV on the target account during deploy.')
    return
  }
  let source = readWrangler()
  for (const binding of active) {
    const before = topLevelId(source, binding)
    const value = process.env[binding.env].trim()
    source = upsertId(source, binding, value)
    console.log(`[workers-builds] Pinned ${binding.label}: ${before ?? '(auto-provision)'} -> ${value}`)
  }
  writeFileSync(WRANGLER_TOML, source)
}

function verifyGeneratedConfig() {
  if (!existsSync(GENERATED_CONFIG)) {
    throw new Error(`Missing ${GENERATED_CONFIG}. Did the build phase run before the deploy phase?`)
  }
  const config = JSON.parse(readFileSync(GENERATED_CONFIG, 'utf8'))
  if (config.name !== 'zpan') {
    throw new Error(`Worker name must be "zpan" to match the Workers Builds project, got "${config.name}"`)
  }
  const d1 = config.d1_databases?.find((entry) => entry.binding === 'DB')
  const kv = config.kv_namespaces?.find((entry) => entry.binding === 'CACHE_KV')
  if (!d1 || !kv) {
    throw new Error('Generated config is missing the DB or CACHE_KV binding')
  }
  console.log(
    `[workers-builds] Generated config: name=${config.name}, DB=${d1.database_id ?? '(auto-provision)'}, CACHE_KV=${kv.id ?? '(auto-provision)'}, assets=${config.assets?.directory ?? '(none)'}`,
  )
}

function build() {
  patchIds()
  pnpm(['build'])
  verifyGeneratedConfig()
}

async function syncWebDav(databaseUuid) {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !accountId) {
    throw new Error('ZPAN_SYNC_WEBDAV requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as Build variables/secrets')
  }
  wrangler(['d1', 'execute', databaseUuid, '--remote', '--command', READINESS_SQL])
  const result = await syncCloudflareWebDav({ token, accountId })
  console.log(`[workers-builds] WebDAV sync: removedRules=${result.removedRules} removedDomains=${result.removedDomains}`)
  const origin = webDavOrigin(result)
  if (!origin) {
    console.log('[workers-builds] No primary Worker Custom Domain found; keeping /dav/')
    return
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(origin)) {
    throw new Error(`Refusing to persist an invalid WebDAV origin: ${origin}`)
  }
  const verifiedAt = new Date().toISOString()
  const sql = `INSERT INTO system_options (key, value) VALUES ('webdav_verified_origin', '${origin}'), ('webdav_verified_at', '${verifiedAt}'), ('webdav_verification_error', '') ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  wrangler(['d1', 'execute', databaseUuid, '--remote', '--command', sql])
  console.log(`[workers-builds] WebDAV custom domain ready: ${origin}/`)
}

async function deploy() {
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.warn(
      '[workers-builds] CLOUDFLARE_ACCOUNT_ID is not set. If the remote D1 migration reports a missing account ID, add it under Settings > Build > Variables and Secrets.',
    )
  }
  console.log('[workers-builds] Deploy command must be `pnpm workers-builds:deploy` in Workers Builds > Settings > Build.')
  // 1. Create/update the Worker. With no resource IDs, this is the step that
  //    triggers Wrangler's automatic provisioning of the remote D1 database.
  wrangler(['deploy'])
  // 2. Migrate the database that actually exists remotely and verify that the
  //    business tables were created. This FAILS LOUDLY instead of leaving an
  //    empty schema behind (which shows up as `no such table: system_options`).
  const database = applyMigrations()
  if (process.env.ZPAN_SYNC_WEBDAV === '1') await syncWebDav(database.uuid)
}

function check() {
  const source = readWrangler()
  console.log('[workers-builds] wrangler.toml top-level bindings:')
  for (const binding of ID_BINDINGS) {
    const current = topLevelId(source, binding)
    const override = process.env[binding.env]?.trim()
    const mode = current === null ? 'auto-provision' : `pinned (${current})`
    console.log(`  ${binding.label.padEnd(24)} ${mode}, override=${override ?? '(none)'}`)
    if (binding.required && current === null) {
      throw new Error(`${binding.label} is required: rate limiting namespaces are not auto-provisioned`)
    }
  }
  const crons = readCronTriggers(source)
  const cronLimit = Number.parseInt(process.env.ZPAN_CRON_LIMIT ?? '5', 10)
  console.log(`[workers-builds] cron triggers: ${crons.length} [${crons.join(', ')}]`)
  if (crons.length > cronLimit) {
    throw new Error(
      `wrangler.toml registers ${crons.length} cron triggers but the account limit is ${cronLimit} ` +
        '(Workers Free allows 5 per account, shared by all Workers). Remove unused crons, or set ' +
        'ZPAN_CRON_LIMIT if the account is on Workers Paid.',
    )
  }
  if (existsSync(GENERATED_CONFIG)) {
    verifyGeneratedConfig()
  } else {
    console.log('[workers-builds] No dist/zpan/wrangler.json yet (build phase has not run).')
  }
  console.log('[workers-builds] check OK')
}

const command = process.argv[2]
try {
  switch (command) {
    case 'build':
      build()
      break
    case 'deploy':
      await deploy()
      break
    case 'migrate':
      applyMigrations()
      break
    case 'verify':
      verify()
      break
    case 'check':
      check()
      break
    default:
      console.error('Usage: node scripts/workers-builds.mjs <build|deploy|migrate|verify|check>')
      process.exitCode = 1
  }
} catch (error) {
  console.error(`[workers-builds] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
