import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { attachmentContentDisposition } from '@shared/content-disposition'
import type { S3Gateway, S3StorageCredentials } from '../../usecases/ports'

const DEFAULT_EXPIRES_IN = 3600
const MULTIPART_PART_SIZE = 5 * 1024 * 1024
const SMALL_STREAM_PUT_BUFFER_SIZE = 256 * 1024

// Only the host is logged; a storage endpoint could contain credentials in its
// query string and those must never reach the Workers log stream.
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return '(invalid)'
  }
}

type SdkRequestError = Error & {
  name?: string
  $metadata?: { httpStatusCode?: number; requestId?: string }
  $response?: { statusCode?: number; headers?: Record<string, string> }
}

const HEAD_DIAGNOSTIC_HEADERS = [
  'location',
  'server',
  'content-type',
  'content-length',
  'connection',
  'www-authenticate',
  'x-amz-request-id',
  'x-amz-id-2',
  'x-amz-bucket-region',
  'x-amz-error-code',
  'x-cos-request-id',
  'x-cos-error-code',
  'x-cos-trace-id',
]

/**
 * A HEAD response has no body, so the SDK cannot parse an XML error code and
 * degrades every failing HEAD to the opaque "UnknownError". The real status,
 * COS headers and request id are still on the error object — surface them so a
 * production-only failure can be diagnosed from the Workers log.
 */
function headFailureDetail(error: unknown, storage: S3StorageCredentials): string {
  const sdkError = error as SdkRequestError | null
  const status = sdkError?.$metadata?.httpStatusCode ?? sdkError?.$response?.statusCode ?? '?'
  const headers = sdkError?.$response?.headers ?? {}
  const diagnosticHeaders =
    Object.entries(headers)
      .filter(([name]) => HEAD_DIAGNOSTIC_HEADERS.includes(name.toLowerCase()))
      .map(([name, value]) => `${name}=${value}`)
      .join(' ') || '(none)'
  return [
    `head_status=${status}`,
    `head_name=${sdkError?.name ?? '?'}`,
    `head_request_id=${sdkError?.$metadata?.requestId ?? '?'}`,
    `head_response_headers=${diagnosticHeaders}`,
    `endpoint=${endpointHost(storage.endpoint)}`,
    `region=${storage.region}`,
    `force_path_style=${storage.forcePathStyle ?? true}`,
  ].join(' ')
}

const SIGNED_REQUEST_CAPTURE_SENTINEL = 'zpan:signed-request-captured'

type SignedRequestSnapshot = {
  method: string
  url: string
  headers: Record<string, string>
  signedHeaders: string
  signedHost: string
  signedValues: string
}

/**
 * workerd has no DOMParser (see deleteObjects), so the SDK cannot deserialize
 * COS's XML error body: a 403 degrades to "ReferenceError: DOMParser is not
 * defined" and the real <Code>/<CanonicalRequest> is lost. Capture the request
 * right after SigV4 signing, then replay it with a plain fetch() whose body we
 * read ourselves. A dedicated client is used, so the capture middleware never
 * touches the presigner that builds the fallback URL.
 */
async function captureSignedGet(client: S3Client, bucket: string, key: string): Promise<SignedRequestSnapshot | null> {
  const stack = (
    client as unknown as {
      middlewareStack?: { add?: (middleware: unknown, options: Record<string, unknown>) => void }
    }
  ).middlewareStack
  // Handler-only clients and test doubles cannot be instrumented.
  if (typeof stack?.add !== 'function') return null

  let captured: SignedRequestSnapshot | null = null
  stack.add(
    () => async (args: unknown) => {
      const request = (args as { request?: Record<string, unknown> }).request
      const hostname = typeof request?.hostname === 'string' ? request.hostname : ''
      const headers = (request?.headers ?? {}) as Record<string, string>
      const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
      // Never replay an unsigned request: that would produce a misleading error.
      if (!hostname || !authorization) throw new Error(SIGNED_REQUEST_CAPTURE_SENTINEL)

      const query = (request?.query ?? {}) as Record<string, string | string[]>
      const params = new URLSearchParams()
      for (const [name, value] of Object.entries(query)) {
        if (Array.isArray(value)) for (const item of value) params.append(name, item)
        else if (value != null) params.append(name, String(value))
      }
      const queryString = params.toString()
      const port = typeof request?.port === 'number' ? `:${request.port}` : ''
      const protocol = typeof request?.protocol === 'string' ? request.protocol : 'https:'
      const path = typeof request?.path === 'string' ? request.path : '/'
      // SignedHeaders is semicolon-separated, so stop at the comma before Signature=.
      const signedHeaders = /SignedHeaders=([^,\s]+)/.exec(authorization)?.[1] ?? '?'
      // Log the VALUE of every signed header (never the signature or any token).
      // COS's <CononicalRequest> echoes what it actually received; comparing the
      // two lists pinpoints the header rewritten on the Cloudflare egress path.
      const signedValues = signedHeaders
        .split(';')
        .map((name) => {
          const sensitive = name.toLowerCase().includes('security-token') || name.toLowerCase().includes('secret')
          const value =
            Object.entries(headers).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1] ?? '(missing)'
          return `${name}=${sensitive ? '<redacted>' : value}`
        })
        .join('|')
        .slice(0, 900)
      captured = {
        method: typeof request?.method === 'string' ? request.method : 'GET',
        url: `${protocol}//${hostname}${port}${path}${queryString ? `?${queryString}` : ''}`,
        headers,
        signedHeaders,
        signedValues,
        signedHost: Object.entries(headers).find(([name]) => name.toLowerCase() === 'host')?.[1] ?? '?',
      }
      throw new Error(SIGNED_REQUEST_CAPTURE_SENTINEL)
    },
    { step: 'finalizeRequest', name: 'zpanCaptureSignedGet', priority: 'low' },
  )

  try {
    await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-0' }))
  } catch (error) {
    if (!(error instanceof Error) || error.message !== SIGNED_REQUEST_CAPTURE_SENTINEL) return null
  }
  return captured
}

/**
 * COS misspells CanonicalRequest as <CononicalRequest>; accept both spellings.
 * That field lists the exact headers COS used to recompute the signature.
 */
export function cosCanonicalRequest(body: string): string {
  return xmlTag(body, 'CononicalRequest') ?? xmlTag(body, 'CanonicalRequest') ?? ''
}

/**
 * Compare the signed header values the SDK produced with those COS echoes back
 * in <CononicalRequest>. A mismatch here IS the root cause of a production-only
 * SignatureDoesNotMatch: something on the egress path rewrote that header.
 */
export function diffSignedHeaders(canonical: string, signedValues: string): string {
  const atCos = new Map<string, string>()
  for (const line of canonical.split(/\r?\n/)) {
    const match = /^([a-z0-9-]+):(.*)$/i.exec(line.trim())
    if (match) atCos.set(match[1].toLowerCase(), match[2].trim())
  }
  const atSdk = new Map<string, string>()
  for (const pair of signedValues.split('|')) {
    const eq = pair.indexOf('=')
    if (eq > 0) atSdk.set(pair.slice(0, eq).toLowerCase(), pair.slice(eq + 1))
  }
  const diffs: string[] = []
  for (const [name, value] of atSdk) {
    const received = atCos.get(name)
    if (received === undefined) diffs.push(`${name}:missing_at_cos`)
    else if (received !== value) {
      diffs.push(`${name}:sdk=${JSON.stringify(value.slice(0, 100))} cos=${JSON.stringify(received.slice(0, 100))}`)
    }
  }
  for (const name of atCos.keys()) if (!atSdk.has(name)) diffs.push(`${name}:extra_at_cos`)
  return diffs.length ? diffs.join(',') : 'none'
}

/** Flatten a COS XML error into one log-safe line. No credentials are logged. */
export function describeCosErrorXml(body: string, status: number): string {
  const field = (tag: string, limit: number): string => {
    const value = xmlTag(body, tag)
    return value ? `${tag}=${JSON.stringify(value.replace(/\s+/g, ' ').trim().slice(0, limit))}` : ''
  }
  const canonical = cosCanonicalRequest(body)
  return [
    `cos_error_status=${status}`,
    field('Code', 80),
    field('Message', 240),
    field('StringToSign', 320),
    canonical ? `CononicalRequest=${JSON.stringify(canonical.replace(/\s+/g, ' ').trim().slice(0, 1500))}` : '',
    field('RequestId', 80),
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Replay the header-signed GET as a raw fetch(). If COS still returns 403 we
 * finally see its XML <Code> (SignatureDoesNotMatch / AccessDenied / ...).
 * If it succeeds, the difference lives in the SDK's request construction, not
 * in the signature or the COS endpoint. Diagnostic only.
 */
async function diagnoseSignedGetReplay(client: S3Client, bucket: string, key: string): Promise<string> {
  try {
    const signed = await captureSignedGet(client, bucket, key)
    if (!signed) return 'signed_get_replay=UNAVAILABLE'
    const headers = new Headers()
    for (const [name, value] of Object.entries(signed.headers)) {
      // workerd owns these; setting them on a Request is ignored or throws.
      if (name.toLowerCase() === 'host' || name.toLowerCase() === 'content-length') continue
      headers.set(name, value)
    }
    const response = await fetch(signed.url, { method: signed.method, headers })
    const body = await response.text()
    const shape =
      `signed_headers=${signed.signedHeaders} signed_host=${JSON.stringify(signed.signedHost)} ` +
      `signed_values=${JSON.stringify(signed.signedValues)}`
    if (response.ok) return `signed_get_replay=OK(status=${response.status}) ${shape}`
    const canonical = cosCanonicalRequest(body)
    const diff = canonical
      ? `header_diff=${diffSignedHeaders(canonical, signed.signedValues)}`
      : 'header_diff=NO_CANONICAL'
    return `signed_get_replay=HTTP(${response.status}) ${shape} ${describeCosErrorXml(body, response.status)} ${diff}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `signed_get_replay=ERROR(${JSON.stringify(message.slice(0, 160))})`
  }
}

/**
 * When a header-signed HEAD fails, repeat the same credential/signing scheme
 * with a 1-byte GET. Under Node the SDK names the XML error; under workerd it
 * cannot, so also replay the signed request with a raw fetch() to recover the
 * body. This separates "the HEAD method is rejected" from "header-signed
 * requests are rejected". Diagnostic only: never used as upload metadata.
 */
async function diagnoseWithHeaderSignedGet(client: S3Client, bucket: string, key: string): Promise<string> {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-0' }))
    const body = result.Body as { destroy?: () => void; cancel?: () => Promise<void> } | undefined
    body?.destroy?.()
    return `header_signed_get=OK(status=${result.$metadata.httpStatusCode})`
  } catch (error) {
    const sdkError = error as SdkRequestError | null
    const status = sdkError?.$metadata?.httpStatusCode ?? sdkError?.$response?.statusCode ?? '?'
    const message = error instanceof Error ? error.message : String(error)
    const replay = await diagnoseSignedGetReplay(client, bucket, key)
    return `header_signed_get=FAIL(status=${status} name=${sdkError?.name ?? '?'} message=${message.slice(0, 160)}) ${replay}`
  }
}

export class S3Service implements S3Gateway {
  createClient(storage: S3StorageCredentials): S3Client {
    return new S3Client({
      region: storage.region,
      endpoint: storage.endpoint,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: storage.accessKey,
        secretAccessKey: storage.secretKey,
      },
      forcePathStyle: storage.forcePathStyle ?? true,
    })
  }

  async presignUpload(
    storage: S3StorageCredentials,
    key: string,
    contentType?: string,
    filenameOrExpiresIn?: string | number,
    expiresIn = DEFAULT_EXPIRES_IN,
  ): Promise<string> {
    let filename: string | undefined
    let ttl = expiresIn
    if (typeof filenameOrExpiresIn === 'string') {
      filename = filenameOrExpiresIn
    } else if (typeof filenameOrExpiresIn === 'number') {
      ttl = filenameOrExpiresIn
    }

    const client = this.createClient(storage)
    // Only sign ContentType/ContentDisposition when provided. A signed header must
    // be sent verbatim by the client or S3 rejects the PUT.
    const command = new PutObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      ...(contentType ? { ContentType: contentType } : {}),
      ...(filename ? { ContentDisposition: attachmentContentDisposition(filename) } : {}),
    })
    const url = await getSignedUrl(client, command, { expiresIn: ttl })
    return url
  }

  async createMultipartUpload(storage: S3StorageCredentials, key: string, contentType?: string): Promise<string> {
    const client = this.createClient(storage)
    const url = await getSignedUrl(
      client,
      new CreateMultipartUploadCommand({
        Bucket: storage.bucket,
        Key: key,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
      { expiresIn: DEFAULT_EXPIRES_IN },
    )
    const response = await fetch(url, {
      method: 'POST',
      ...(contentType ? { headers: { 'Content-Type': contentType } } : {}),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`S3 multipart upload create failed: ${response.status}: ${body.trim()}`)
    const uploadId = xmlTag(body, 'UploadId')
    if (!uploadId) throw new Error('S3 multipart upload did not return an upload id')
    return uploadId
  }

  async presignUploadPart(
    storage: S3StorageCredentials,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = DEFAULT_EXPIRES_IN,
  ): Promise<string> {
    const client = this.createClient(storage)
    return getSignedUrl(
      client,
      new UploadPartCommand({ Bucket: storage.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn },
    )
  }

  async completeMultipartUpload(
    storage: S3StorageCredentials,
    key: string,
    uploadId: string,
    parts: Array<{ etag: string; partNumber: number }>,
  ): Promise<void> {
    const client = this.createClient(storage)
    const sortedParts = parts
      .map((part) => ({ ETag: part.etag, PartNumber: part.partNumber }))
      .sort((a, b) => a.PartNumber - b.PartNumber)
    const url = await getSignedUrl(
      client,
      new CompleteMultipartUploadCommand({
        Bucket: storage.bucket,
        Key: key,
        UploadId: uploadId,
      }),
      { expiresIn: DEFAULT_EXPIRES_IN },
    )
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: multipartCompleteXml(sortedParts),
    })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(`S3 multipart upload complete failed: ${response.status}: ${body.trim()}`)
    }
    if (xmlTag(body, 'Error') !== null || xmlTag(body, 'Code') !== null) {
      throw new Error(`S3 multipart upload complete failed: ${response.status}: ${body.trim()}`)
    }
  }

  async abortMultipartUpload(storage: S3StorageCredentials, key: string, uploadId: string): Promise<void> {
    const client = this.createClient(storage)
    const url = await getSignedUrl(
      client,
      new AbortMultipartUploadCommand({ Bucket: storage.bucket, Key: key, UploadId: uploadId }),
      { expiresIn: DEFAULT_EXPIRES_IN },
    )
    const response = await fetch(url, { method: 'DELETE' })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`S3 multipart upload abort failed: ${response.status}: ${body.trim()}`)
    }
  }

  async presignDownload(
    storage: S3StorageCredentials,
    key: string,
    filename: string,
    expiresIn = DEFAULT_EXPIRES_IN,
  ): Promise<string> {
    const client = this.createClient(storage)
    const command = new GetObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      ResponseContentDisposition: attachmentContentDisposition(filename),
    })
    const url = await getSignedUrl(client, command, { expiresIn })
    return url
  }

  async presignInline(
    storage: S3StorageCredentials,
    key: string,
    mime: string,
    expiresIn = DEFAULT_EXPIRES_IN,
  ): Promise<string> {
    const client = this.createClient(storage)
    const command = new GetObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseContentType: mime,
    })
    const url = await getSignedUrl(client, command, { expiresIn })
    return url
  }

  async headObject(
    storage: S3StorageCredentials,
    key: string,
  ): Promise<{ size: number; contentType?: string; etag: string }> {
    const client = this.createClient(storage)
    // Keep the SDK's header-signed HEAD as the primary path. The same command
    // succeeds under Node's HTTP handler AND under workerd (verified against
    // real COS with scripts/diagnose-cos-head.ts / diagnose-cos-handler.ts), so
    // a query-signed HEAD is not needed. When it does fail, record everything
    // the opaque "UnknownError" hides before falling back.
    try {
      const result = await client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }))
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType,
        etag: (result.ETag ?? '').replace(/"/g, ''),
      }
    } catch (headError) {
      const headMessage = headError instanceof Error ? headError.message : String(headError)
      const detail = headFailureDetail(headError, storage)
      // A dedicated client: the diagnostic middleware must never be attached to
      // the client that presigns the fallback URL below.
      const comparison = await diagnoseWithHeaderSignedGet(this.createClient(storage), storage.bucket, key)
      // Last resort: a query-signed GET, the method every proxy forwards.
      try {
        const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: storage.bucket, Key: key }), {
          expiresIn: 60,
        })
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Cache-Control': 'no-cache' },
        })
        const probe = {
          size: Number(response.headers.get('content-length') ?? 0) || 0,
          contentType: response.headers.get('content-type') ?? undefined,
          etag: (response.headers.get('etag') ?? '').replace(/"/g, ''),
        }
        // Headers are all we need; stop the body before the object streams.
        await response.body?.cancel()
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        console.warn(
          `s3.head.fallback bucket=${storage.bucket} key=${key} ` +
            `head_error=${headMessage.slice(0, 200)} ${detail} ${comparison} probe_size=${probe.size}`,
        )
        return probe
      } catch (probeError) {
        const probeMessage = probeError instanceof Error ? probeError.message : String(probeError)
        throw new Error(
          `HEAD failed (${headMessage}; ${detail}; ${comparison}); presigned GET probe failed (${probeMessage})`,
        )
      }
    }
  }

  async getObjectBytes(storage: S3StorageCredentials, key: string, range?: string): Promise<Uint8Array> {
    return bodyToBytes(await this.getObjectBody(storage, key, range))
  }

  async getObjectBody(storage: S3StorageCredentials, key: string, range?: string): Promise<BodyInit> {
    const client = this.createClient(storage)
    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: storage.bucket, Key: key }), {
      expiresIn: DEFAULT_EXPIRES_IN,
    })
    const response = await fetch(url, range ? { headers: { Range: range } } : undefined)
    if (!response.ok) throw new Error(`S3 object read failed: ${response.status}`)
    if (!response.body) return response.arrayBuffer()
    return response.body
  }

  async getObjectStream(
    storage: S3StorageCredentials,
    key: string,
    range?: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const body = await this.getObjectBody(storage, key, range)
    return bodyToReadableStream(body)
  }

  async copyObject(
    srcStorage: S3StorageCredentials,
    srcKey: string,
    dstStorage: S3StorageCredentials,
    dstKey: string,
  ): Promise<void> {
    const client = this.createClient(dstStorage)
    const copySource = `${srcStorage.bucket}/${srcKey}`
    const url = await getSignedUrl(
      client,
      new CopyObjectCommand({
        CopySource: copySource,
        Bucket: dstStorage.bucket,
        Key: dstKey,
      }),
      {
        expiresIn: DEFAULT_EXPIRES_IN,
        unhoistableHeaders: new Set(['x-amz-copy-source']),
      },
    )
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'x-amz-copy-source': copySource },
    })
    const body = await response.text()
    if (!response.ok || xmlTag(body, 'Error') !== null || xmlTag(body, 'Code') !== null) {
      throw new Error(`S3 object copy failed: ${response.status}: ${body.trim()}`)
    }
    if (xmlTag(body, 'ETag') === null) {
      throw new Error(`S3 object copy failed: ${response.status}: missing ETag`)
    }
  }

  async streamCopy(
    srcStorage: S3StorageCredentials,
    srcKey: string,
    dstStorage: S3StorageCredentials,
    dstKey: string,
  ): Promise<void> {
    const srcClient = this.createClient(srcStorage)
    const getResult = await srcClient.send(new GetObjectCommand({ Bucket: srcStorage.bucket, Key: srcKey }))
    if (!getResult.Body) throw new Error('Empty body from source object')

    const dstClient = this.createClient(dstStorage)
    await dstClient.send(
      new PutObjectCommand({
        Bucket: dstStorage.bucket,
        Key: dstKey,
        // biome-ignore lint/suspicious/noExplicitAny: AWS SDK stream type differs across Node and CF Workers runtimes
        Body: getResult.Body as any,
        ContentType: getResult.ContentType,
        ContentLength: getResult.ContentLength,
      }),
    )
  }

  async putObject(
    storage: S3StorageCredentials,
    key: string,
    body: ReadableStream | Uint8Array,
    contentType: string,
    contentLength?: number,
  ): Promise<number> {
    if (body instanceof ReadableStream) {
      if (contentLength === undefined) return this.putObjectMultipartStream(storage, key, body, contentType)
      if (contentLength <= SMALL_STREAM_PUT_BUFFER_SIZE) {
        const bytes = await streamToBytes(body)
        if (bytes.byteLength !== contentLength) throw new Error('Request body length does not match Content-Length')
        return this.putObject(storage, key, bytes, contentType)
      }
      await this.putObjectStream(storage, key, body, contentType, contentLength)
      return contentLength
    }

    const client = this.createClient(storage)
    await client.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    )
    return body.byteLength
  }

  private async putObjectStream(
    storage: S3StorageCredentials,
    key: string,
    body: ReadableStream,
    contentType: string,
    contentLength: number,
  ): Promise<void> {
    const url = await this.presignUpload(storage, key, contentType)
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(contentLength),
      },
      body,
    })
    if (!response.ok) throw new Error(`S3 stream upload failed: ${response.status}`)
  }

  private async putObjectMultipartStream(
    storage: S3StorageCredentials,
    key: string,
    body: ReadableStream,
    contentType: string,
  ): Promise<number> {
    const uploadId = await this.createMultipartUpload(storage, key, contentType)
    const client = this.createClient(storage)

    const reader = body.getReader()
    const parts: Array<{ ETag: string; PartNumber: number }> = []
    let pending = new Uint8Array() as Uint8Array<ArrayBufferLike>
    let total = 0

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        pending = concatBytes(pending, value)
        while (pending.byteLength >= MULTIPART_PART_SIZE) {
          const part = pending.slice(0, MULTIPART_PART_SIZE)
          pending = pending.slice(MULTIPART_PART_SIZE)
          parts.push(await this.uploadPart(client, storage.bucket, key, uploadId, parts.length + 1, part))
          total += part.byteLength
        }
      }

      if (pending.byteLength > 0) {
        parts.push(await this.uploadPart(client, storage.bucket, key, uploadId, parts.length + 1, pending))
        total += pending.byteLength
      }

      if (parts.length === 0) {
        await this.abortMultipartUpload(storage, key, uploadId)
        await client.send(
          new PutObjectCommand({
            Bucket: storage.bucket,
            Key: key,
            Body: new Uint8Array(),
            ContentType: contentType,
            ContentLength: 0,
          }),
        )
        return 0
      }

      await this.completeMultipartUpload(
        storage,
        key,
        uploadId,
        parts.map((part) => ({ etag: part.ETag, partNumber: part.PartNumber })),
      )
      return total
    } catch (e) {
      await this.abortMultipartUpload(storage, key, uploadId)
      throw e
    }
  }

  private async uploadPart(
    client: S3Client,
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array<ArrayBufferLike>,
  ): Promise<{ ETag: string; PartNumber: number }> {
    const result = await client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength,
      }),
    )
    return { ETag: result.ETag ?? `"part-${partNumber}"`, PartNumber: partNumber }
  }

  async deleteObject(storage: S3StorageCredentials, key: string): Promise<void> {
    const client = this.createClient(storage)
    await client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }))
  }

  async deleteObjects(storage: S3StorageCredentials, keys: string[]): Promise<void> {
    if (keys.length === 0) return
    // DeleteObjectsCommand returns XML which requires DOMParser to parse.
    // Cloudflare Workers doesn't have DOMParser, so we delete one-by-one.
    await Promise.all(keys.map((key) => this.deleteObject(storage, key)))
  }
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  const streamBody = body as {
    transformToByteArray?: () => Promise<Uint8Array>
    arrayBuffer?: () => Promise<ArrayBuffer>
  }
  if (streamBody.transformToByteArray) return streamBody.transformToByteArray()
  if (body instanceof Uint8Array) return body
  if (body instanceof ReadableStream) return streamToBytes(body)
  if (streamBody.arrayBuffer) return new Uint8Array(await streamBody.arrayBuffer())

  throw new Error('Unsupported object body')
}

async function streamToBytes(body: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer())
}

function bodyToReadableStream(body: BodyInit): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>
  if (body instanceof Uint8Array) return bytesToStream(body)
  if (body instanceof ArrayBuffer) return bytesToStream(new Uint8Array(body))
  if (body instanceof Blob) return body.stream()
  throw new Error('Unsupported object body')
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.byteLength === 0) return right
  const merged = new Uint8Array(left.byteLength + right.byteLength)
  merged.set(left)
  merged.set(right, left.byteLength)
  return merged
}

function multipartCompleteXml(parts: Array<{ ETag: string; PartNumber: number }>): string {
  return `<CompleteMultipartUpload>${parts
    .map((part) => `<Part><PartNumber>${part.PartNumber}</PartNumber><ETag>${xmlEscape(part.ETag)}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`
}

function xmlTag(xml: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`).exec(xml)
  return match ? xmlUnescape(match[1].trim()) : null
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

export type { S3StorageCredentials } from '../../usecases/ports'
