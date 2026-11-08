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
// `pnpm workers-builds:check` is a read-only self-check, safe to run locally.

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

function readWrangler() {
  return readFileSync(WRANGLER_TOML, 'utf8')
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

async function syncWebDav() {
  const token = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!token || !accountId) {
    throw new Error('ZPAN_SYNC_WEBDAV requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as Build variables/secrets')
  }
  pnpm(['exec', 'wrangler', 'd1', 'execute', 'DB', '--remote', '--command', READINESS_SQL])
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
  pnpm(['exec', 'wrangler', 'd1', 'execute', 'DB', '--remote', '--command', sql])
  console.log(`[workers-builds] WebDAV custom domain ready: ${origin}/`)
}

async function deploy() {
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.warn(
      '[workers-builds] CLOUDFLARE_ACCOUNT_ID is not set. If the remote D1 migration reports a missing account ID, add it under Settings > Build > Variables and Secrets.',
    )
  }
  // 1. Create/update the Worker. With no resource IDs, this is the step that
  //    triggers Wrangler's automatic provisioning of the remote D1 database.
  pnpm(['exec', 'wrangler', 'deploy'])
  // 2. Migrate by BINDING name, so renamed / auto-provisioned databases still
  //    resolve. Running this before deploy would fail on a brand-new account.
  pnpm(['db:migrate:d1:prod'])
  if (process.env.ZPAN_SYNC_WEBDAV === '1') await syncWebDav()
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
  if (existsSync(GENERATED_CONFIG)) {
    verifyGeneratedConfig()
  } else {
    console.log('[workers-builds] No dist/zpan/wrangler.json yet (build phase has not run).')
  }
  console.log('[workers-builds] check OK')
}

const command = process.argv[2]
switch (command) {
  case 'build':
    build()
    break
  case 'deploy':
    await deploy()
    break
  case 'check':
    check()
    break
  default:
    console.error('Usage: node scripts/workers-builds.mjs <build|deploy|check>')
    process.exitCode = 1
}
