/**
 * Local HEAD probe for COS / S3-compatible storages.
 *
 * This reproduces server/adapters/gateways/s3.ts::headObject() with the exact
 * same S3Service.createClient() configuration, then runs a matrix of variants
 * that isolates WHY the SDK HEAD fails while a presigned GET succeeds.
 *
 * Usage (from the repo root, Node 24):
 *
 *   # put credentials in .dev.vars (already gitignored):
 *   COS_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com
 *   COS_REGION=ap-guangzhou
 *   COS_BUCKET=zpan-1251773322
 *   COS_ACCESS_KEY=AKIDxxxxxxxx
 *   COS_SECRET_KEY=xxxxxxxx
 *   COS_FORCE_PATH_STYLE=true
 *
 *   pnpm exec tsx scripts/diagnose-cos-head.ts [object-key]
 *
 * Alternative: export the COS_* variables in the shell, or point
 * COS_ENV_FILE at a different KEY=VALUE file. Secrets are never printed.
 * Set COS_DEBUG=1 to dump the full SDK error object for every failure.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { S3Service } from '../server/adapters/gateways/s3'
import type { S3StorageCredentials } from '../server/usecases/ports/s3'

const DEFAULT_KEY = '3haZvLYymDSZ2kGtXxdKXl/20261111/SJFBk2I0nQ6k0JER6.zip'
const INTERESTING_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'etag',
  'location',
  'server',
  'www-authenticate',
  'x-amz-request-id',
  'x-amz-id-2',
  'x-amz-bucket-region',
  'x-amz-error-code',
  'x-cos-request-id',
  'x-cos-trace-id',
  'x-cos-error-code',
]

type ProbeResult = { label: string; ok: boolean; ms: number; detail: string }

type SdkError = Error & {
  $metadata?: Record<string, unknown>
  $fault?: string
  $response?: { statusCode?: number; headers?: Record<string, string> }
  Code?: string
  code?: string
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

function mask(value: string): string {
  if (value.length <= 8) return '********'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

function headerLine(headers: Record<string, string>): string {
  const picked = Object.entries(headers)
    .filter(([name]) => INTERESTING_HEADERS.includes(name.toLowerCase()))
    .map(([name, value]) => `${name}=${value}`)
  return picked.length ? picked.join('  ') : '(no diagnostic headers)'
}

function responseLine(response: Response): string {
  const headers = Object.fromEntries(response.headers.entries())
  return `HTTP ${response.status} ${response.statusText}  ${headerLine(headers)}`
}

function httpError(method: string, response: Response, body: string): SdkError {
  const error = new Error(
    `${method} -> HTTP ${response.status} ${response.statusText}; body=${body.slice(0, 400) || '(empty, HEAD has no body)'}`,
  ) as SdkError
  error.name = `HttpStatus${response.status}`
  error.$metadata = { httpStatusCode: response.status }
  error.$response = {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
  }
  return error
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const e = error as SdkError
  const meta = e.$metadata ?? {}
  const headers = e.$response?.headers ?? {}
  const status = meta.httpStatusCode ?? e.$response?.statusCode ?? '?'
  const requestId =
    meta.requestId ??
    meta.extendedRequestId ??
    headers['x-amz-request-id'] ??
    headers['x-cos-request-id'] ??
    '?'
  return [
    `name=${e.name}`,
    `message=${e.message.slice(0, 300)}`,
    `httpStatus=${status}`,
    `code=${e.Code ?? e.code ?? e.name}`,
    `requestId=${requestId}`,
    `fault=${e.$fault ?? '?'}`,
    `headers: ${headerLine(headers)}`,
  ].join('\n  ')
}

async function probe(label: string, results: ProbeResult[], run: () => Promise<string>): Promise<void> {
  const started = performance.now()
  try {
    const detail = await run()
    const ms = Math.round(performance.now() - started)
    results.push({ label, ok: true, ms, detail })
    console.log(`\n[${label}] PASS (${ms} ms)\n  ${detail}`)
  } catch (error) {
    const ms = Math.round(performance.now() - started)
    const detail = describeError(error)
    results.push({ label, ok: false, ms, detail })
    console.log(`\n[${label}] FAIL (${ms} ms)\n  ${detail}`)
    if (process.env.COS_DEBUG === '1') {
      console.log(inspect(error, { depth: 8, colors: false, maxArrayLength: 20 }))
    }
  }
}

async function fetchSigned(
  client: S3Client,
  command: HeadObjectCommand | GetObjectCommand,
  method: 'HEAD' | 'GET',
): Promise<string> {
  const url = await getSignedUrl(client, command, { expiresIn: 120 })
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    ...(method === 'GET' ? { headers: { 'Cache-Control': 'no-cache' } } : {}),
  })
  const line = responseLine(response)
  if (!response.ok) {
    // GET error responses carry an XML <Code>/<Message>; HEAD never has a body.
    const body = method === 'GET' ? (await response.text()).slice(0, 400) : ''
    throw httpError(`presigned ${method}`, response, body)
  }
  await response.body?.cancel().catch(() => {})
  return line
}

async function main(): Promise<void> {
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
    console.error('See the usage comment at the top of scripts/diagnose-cos-head.ts')
    process.exit(1)
  }

  console.log('=== CONFIGURATION (secrets masked) ===')
  console.log(`  endpoint       : ${storage.endpoint}`)
  console.log(`  region         : ${storage.region}`)
  console.log(`  bucket         : ${storage.bucket}`)
  console.log(`  forcePathStyle : ${storage.forcePathStyle}`)
  console.log(`  accessKey      : ${mask(storage.accessKey)}`)
  console.log(`  object key     : ${key}`)
  console.log('\n=== PROBES ===')

  const service = new S3Service()
  // Exactly the client used by presignUpload() and headObject() in production.
  const client = service.createClient(storage)
  const results: ProbeResult[] = []

  await probe('1 SDK HEAD (header-signed)', results, async () => {
    const out = await client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }))
    return `ContentLength=${out.ContentLength} ETag=${out.ETag} ContentType=${out.ContentType} httpStatus=${out.$metadata.httpStatusCode}`
  })

  await probe('2 S3Service.headObject() (SDK HEAD, presigned-GET fallback)', results, async () => {
    const out = await service.headObject(storage, key)
    return JSON.stringify(out)
  })

  await probe('3 Presigned HEAD (query-signed)', results, () =>
    fetchSigned(client, new HeadObjectCommand({ Bucket: storage.bucket, Key: key }), 'HEAD'),
  )

  await probe('4 SDK GET Range (header-signed)', results, async () => {
    const out = await client.send(
      new GetObjectCommand({ Bucket: storage.bucket, Key: key, Range: 'bytes=0-0' }),
    )
    const body = out.Body as { destroy?: () => void } | undefined
    body?.destroy?.()
    return `ContentRange=${out.ContentRange} ContentLength=${out.ContentLength} ETag=${out.ETag} httpStatus=${out.$metadata.httpStatusCode}`
  })

  await probe('5 Presigned GET (query-signed, the production fallback)', results, () =>
    fetchSigned(client, new GetObjectCommand({ Bucket: storage.bucket, Key: key }), 'GET'),
  )

  await probe('6 SDK ListObjectsV2 (header-signed GET)', results, async () => {
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: key, MaxKeys: 1 }),
    )
    return `KeyCount=${out.KeyCount} firstKey=${out.Contents?.[0]?.Key ?? '(none)'} httpStatus=${out.$metadata.httpStatusCode}`
  })

  const altClient = service.createClient({ ...storage, forcePathStyle: !storage.forcePathStyle })
  await probe(`7 SDK HEAD (forcePathStyle=${!storage.forcePathStyle})`, results, async () => {
    const out = await altClient.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }))
    return `ContentLength=${out.ContentLength} ETag=${out.ETag} httpStatus=${out.$metadata.httpStatusCode}`
  })

  console.log('\n=== SUMMARY ===')
  for (const result of results) {
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.label.padEnd(56)} ${result.ms} ms`)
  }

  const [p1, , p3, p4, p5, p6, p7] = results
  console.log('\n=== INTERPRETATION ===')
  if (p1?.ok) {
    console.log('  HEAD works locally. The production failure is specific to the')
    console.log('  Cloudflare Workers runtime (its fetch-based HTTP handler), not COS.')
  } else if (p6 && !p6.ok) {
    console.log('  A header-signed GET also fails -> credential / region / endpoint problem,')
    console.log('  not a HEAD-specific issue. Check COS_REGION and COS_ENDPOINT.')
  } else if (p3?.ok) {
    console.log('  Query-signed HEAD succeeds but header-signed HEAD fails -> the SDK request')
    console.log('  shape (Authorization header / signed headers) is rejected. Not a permission')
    console.log('  problem and not a missing object.')
  } else if (p4?.ok) {
    console.log('  Header-signed GET succeeds but HEAD fails -> the HEAD method itself is')
    console.log('  rejected by COS or a gateway in front of the endpoint.')
  } else if (p5?.ok) {
    console.log('  Only the query-signed GET works. Inspect the httpStatus / headers of each')
    console.log('  FAIL above (and rerun with COS_DEBUG=1 for the raw SDK error).')
  }
  if (p7?.ok && !p1?.ok) {
    console.log(`  ForcePathStyle=${!storage.forcePathStyle} fixes HEAD -> change the storage`)
    console.log('  setting (COS buckets created after 2024-01-01 reject path-style).')
  }
  console.log('\n  Paste the full output back to correlate with the Workers log line')
  console.log('  "s3.head.fallback ... head_error=UnknownError".')
}

main().catch((error) => {
  console.error('Probe crashed:', error)
  process.exit(1)
})
