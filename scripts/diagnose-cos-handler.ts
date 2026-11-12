/**
 * Isolate why the SDK's header-signed HEAD fails inside Cloudflare Workers.
 *
 * The Worker build maps @aws-sdk/client-s3's `dist-es/runtimeConfig` to
 * `runtimeConfig.browser` (package.json "browser" field), which swaps
 * NodeHttpHandler for FetchHttpHandler, the node sha256/md5 implementations for
 * browser ones, and the user-agent provider. Everything else (credentials,
 * region, endpoint, signer) is identical.
 *
 * This script runs BOTH handlers in one Node process against the real COS
 * endpoint, dumps the fully-signed HttpRequest each one produced, and replays
 * those exact requests with a raw fetch(). No secrets are printed.
 *
 * Usage (from repo root, Node 24):
 *   pnpm exec tsx scripts/diagnose-cos-handler.ts [object-key]
 *
 * Credentials come from .dev.vars (gitignored), same as diagnose-cos-head.ts.
 */

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { inspect } from 'node:util'
import { S3Service } from '../server/adapters/gateways/s3'
import type { S3StorageCredentials } from '../server/usecases/ports/s3'

const DEFAULT_KEY = '3haZvLYymDSZ2kGtXxdKXl/20261111/SJFBk2I0nQ6k0JER6.zip'

type HttpRequestShape = {
  method: string
  protocol: string
  hostname: string
  port?: number
  path: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  body?: unknown
}

const nodeRequire = createRequire(import.meta.url)
const sdkRequire = createRequire(nodeRequire.resolve('@aws-sdk/client-s3'))
const { FetchHttpHandler } = sdkRequire('@smithy/fetch-http-handler') as {
  FetchHttpHandler: new (options?: Record<string, unknown>) => unknown
}
const { NodeHttpHandler } = sdkRequire('@smithy/node-http-handler') as {
  NodeHttpHandler: new (options?: Record<string, unknown>) => unknown
}

function loadEnvFile(): void {
  const file = process.env.COS_ENV_FILE ?? '.dev.vars'
  try {
    const text = readFileSync(file, 'utf8')
    let loaded = 0
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 1) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined && value) {
        process.env[key] = value
        loaded++
      }
    }
    console.log(`(env file: ${file}, ${loaded} variable(s) loaded)`)
  } catch {
    console.log(`(env file: ${file} not found, using process environment only)`)
  }
}

/** Keep Credential/SignedHeaders visible but redact the signature itself. */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') {
      const signed = /SignedHeaders=([^,;\s]+)/.exec(value)?.[1]
      const credential = /Credential=([^,;\s]+)/.exec(value)?.[1]?.split('/')[0]
      out[name] = `AWS4-HMAC-SHA256 Credential=${credential ?? '?'}/... SignedHeaders=${signed ?? '?'} Signature=<redacted>`
    } else if (name.toLowerCase().includes('secret') || name.toLowerCase() === 'x-amz-security-token') {
      out[name] = '<redacted>'
    } else {
      out[name] = value
    }
  }
  return out
}

function snapshot(request: HttpRequestShape): string {
  const url = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${request.path}`
  const lines = [`  ${request.method} ${url}`, `  query=${JSON.stringify(request.query)}`]
  for (const [name, value] of Object.entries(redactHeaders(request.headers))) {
    lines.push(`  ${name}: ${value}`)
  }
  return lines.join('\n')
}

function responseHeaders(response: Response): string {
  const entries = [...response.headers.entries()]
  return entries.length ? entries.map(([k, v]) => `  ${k}: ${v}`).join('\n') : '  (none)'
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const e = error as Error & Record<string, unknown>
  const meta = (e.$metadata ?? {}) as Record<string, unknown>
  const response = (e.$response ?? {}) as { statusCode?: number; headers?: Record<string, string> }
  const lines = [
    `name=${e.name}`,
    `message=${e.message.slice(0, 300)}`,
    `httpStatus=${meta.httpStatusCode ?? response.statusCode ?? '?'}`,
    `requestId=${meta.requestId ?? '?'}`,
  ]
  if (response.headers) {
    lines.push('  sdk error $response.headers:')
    lines.push(
      Object.entries(response.headers)
        .map(([k, v]) => `    ${k}: ${v}`)
        .join('\n'),
    )
  }
  lines.push(`  own keys: ${Object.keys(e).join(', ')}`)
  return lines.join('\n')
}

class DumpHandler {
  constructor(
    private readonly inner: { handle: (request: unknown, options?: unknown) => Promise<unknown> } & Record<
      string,
      unknown
    >,
    private readonly label: string,
    private readonly sink: (request: HttpRequestShape) => void,
  ) {}

  handle(request: HttpRequestShape, options?: unknown): Promise<unknown> {
    this.sink(request)
    return this.inner.handle(request, options)
  }

  updateHttpClientConfig(key: string, value: unknown): void {
    ;(this.inner.updateHttpClientConfig as ((k: string, v: unknown) => void) | undefined)?.(key, value)
  }

  httpHandlerConfigs(): Record<string, unknown> {
    return (this.inner.httpHandlerConfigs as (() => Record<string, unknown>) | undefined)?.() ?? {}
  }

  destroy(): void {
    ;(this.inner.destroy as (() => void) | undefined)?.()
  }
}

async function run(): Promise<void> {
  loadEnvFile()
  const storage: S3StorageCredentials = {
    bucket: process.env.COS_BUCKET ?? '',
    endpoint: process.env.COS_ENDPOINT ?? '',
    region: process.env.COS_REGION ?? '',
    accessKey: process.env.COS_ACCESS_KEY ?? process.env.COS_SECRET_ID ?? '',
    secretKey: process.env.COS_SECRET_KEY ?? '',
    forcePathStyle: (process.env.COS_FORCE_PATH_STYLE ?? 'true').toLowerCase() === 'true',
  }
  const key = process.argv[2] ?? process.env.COS_KEY ?? DEFAULT_KEY
  const missing = Object.entries({
    COS_ENDPOINT: storage.endpoint,
    COS_REGION: storage.region,
    COS_BUCKET: storage.bucket,
    COS_ACCESS_KEY: storage.accessKey,
    COS_SECRET_KEY: storage.secretKey,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length) {
    console.error(`Missing credentials: ${missing.join(', ')}`)
    process.exit(1)
  }

  console.log('=== CONFIGURATION (secrets masked) ===')
  console.log(`  endpoint=${storage.endpoint} region=${storage.region} bucket=${storage.bucket}`)
  console.log(`  forcePathStyle=${storage.forcePathStyle} key=${key}`)

  const service = new S3Service()
  const base = service.createClient(storage)
  console.log(`\nDefault handler in this runtime: ${(base.config.requestHandler as object).constructor.name}`)

  // Rebuild the production client options verbatim; only the handler varies.
  const clientOptions = {
    region: storage.region,
    endpoint: storage.endpoint,
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
    forcePathStyle: storage.forcePathStyle ?? true,
  }
  const captured: Record<string, HttpRequestShape> = {}
  const handlers: Array<{ label: string; client: S3Client }> = [
    {
      label: 'A NodeHttpHandler (local Node default)',
      client: new S3Client({
        ...clientOptions,
        requestHandler: new DumpHandler(new NodeHttpHandler() as never, 'node', (r) => {
          captured.node = structuredClone(r)
        }) as never,
      }),
    },
    {
      label: 'B FetchHttpHandler (Cloudflare Workers default)',
      client: new S3Client({
        ...clientOptions,
        requestHandler: new DumpHandler(new FetchHttpHandler() as never, 'fetch', (r) => {
          captured.fetch = structuredClone(r)
        }) as never,
      }),
    },
  ]

  for (const { label, client } of handlers) {
    console.log(`\n=== ${label} ===`)
    try {
      const out = await client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }))
      console.log(`  PASS httpStatus=${out.$metadata.httpStatusCode} ContentLength=${out.ContentLength} ETag=${out.ETag}`)
    } catch (error) {
      console.log(`  FAIL\n${describeError(error)}`)
      if (process.env.COS_DEBUG === '1') console.log(inspect(error, { depth: 8, colors: false }))
    }
  }

  const a = captured.node
  const b = captured.fetch
  console.log('\n=== SIGNED REQUEST: NODE HANDLER ===')
  if (a) console.log(snapshot(a))
  console.log('\n=== SIGNED REQUEST: FETCH HANDLER ===')
  if (b) console.log(snapshot(b))

  if (a && b) {
    const names = new Set([...Object.keys(a.headers).map((x) => x.toLowerCase()), ...Object.keys(b.headers).map((x) => x.toLowerCase())])
    const lower = (r: HttpRequestShape, n: string) =>
      Object.entries(r.headers).find(([k]) => k.toLowerCase() === n)?.[1]
    console.log('\n=== HEADER DIFF (node -> fetch) ===')
    for (const name of [...names].sort()) {
      const av = lower(a, name)
      const bv = lower(b, name)
      if (av === bv) continue
      if (name === 'authorization') {
        console.log(`  ${name}: ${av === bv ? 'same' : 'DIFFERENT (expected: different UA/date/signature)'}`)
      } else {
        console.log(`  ${name}: node=${JSON.stringify(av)} fetch=${JSON.stringify(bv)}`)
      }
    }
    console.log(`  url: node=${a.protocol}//${a.hostname}${a.path} fetch=${b.protocol}//${b.hostname}${b.path}`)
    console.log(`  method: node=${a.method} fetch=${b.method}`)
  }

  // Replay each captured signed request with a plain fetch(): this bypasses the
  // handler's Request construction entirely and exposes COS's real response.
  for (const [label, request] of [
    ['node', a],
    ['fetch', b],
  ] as const) {
    if (!request) continue
    console.log(`\n=== RAW FETCH REPLAY of the ${label}-handler signed request ===`)
    const query = new URLSearchParams()
    for (const [k, v] of Object.entries(request.query ?? {})) {
      if (Array.isArray(v)) for (const item of v) query.append(k, item)
      else if (v != null) query.append(k, String(v))
    }
    const qs = query.toString()
    const url = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${request.path}${qs ? `?${qs}` : ''}`
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() === 'host' || name.toLowerCase() === 'content-length') continue
      headers.set(name, value)
    }
    try {
      const response = await fetch(url, { method: request.method, headers })
      console.log(`  HTTP ${response.status} ${response.statusText}`)
      console.log(responseHeaders(response))
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        console.log(`  body=${body.slice(0, 300) || '(empty)'}`)
      }
    } catch (error) {
      console.log(`  fetch threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.log('\n=== INTERPRETATION ===')
  console.log('  * A and B normally produce byte-identical signed requests: signing is done')
  console.log('    by the SDK middleware, not by the HTTP handler. Only the handler differs.')
  console.log('  * If B fails with "stream.pipe is not a function", that is an artifact of')
  console.log('    forcing FetchHttpHandler onto a NODE runtimeConfig in this script (the')
  console.log('    node streamCollector expects a Node stream). It is NOT a COS rejection.')
  console.log('  * Both raw replays returning 200 proves COS accepts the header-signed HEAD')
  console.log('    and the signature itself. A production-only failure then lives in the')
  console.log('    real Cloudflare edge / runtime, not in COS, the SDK or the request shape.')
  console.log('  * SDK "UnknownError" still carries $response.headers; log those plus')
  console.log('    $metadata.httpStatusCode to identify the real production status/code.')
}

run().catch((error) => {
  console.error('Probe crashed:', error)
  process.exit(1)
})
