import {
  type CanonicalStatus,
  canonicalStatusForHttp,
  ERROR_DOMAIN,
  ERROR_INFO_TYPE,
  ErrorReason,
  type ErrorResponse,
} from '@shared/schemas'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AppError, NameConflictError, ObjectUploadSessionError, WebDavPathError } from '../usecases/ports'

// Per-error overrides for the AIP-193 body. `reason` defaults to the canonical
// `status`; `status` defaults to the HTTP-status mapping; `domain` to zpan.dev.
export interface ErrorOptions {
  reason?: string
  status?: CanonicalStatus
  metadata?: Record<string, string>
  domain?: string
}

// The single place that builds an AIP-193 (`google.rpc.Status`) error body. Every
// error the API surfaces — `AppError` values and mapped domain errors, all rendered
// by `jsonError` — flows through here, so the wire shape is defined exactly once.
export function buildErrorBody(httpStatus: number, message: string, opts: ErrorOptions = {}): ErrorResponse {
  const status = opts.status ?? canonicalStatusForHttp(httpStatus)
  const reason = opts.reason ?? status
  return {
    error: {
      code: httpStatus,
      message,
      status,
      details: [
        {
          '@type': ERROR_INFO_TYPE,
          reason,
          domain: opts.domain ?? ERROR_DOMAIN,
          ...(opts.metadata ? { metadata: opts.metadata } : {}),
        },
      ],
    },
  }
}

export interface DomainErrorMapping {
  status: ContentfulStatusCode
  /** Plain message for text responses (e.g. WebDAV). */
  message: string
  /** AIP-193 body for JSON responses. */
  json: ErrorResponse
}

const mapping = (status: ContentfulStatusCode, message: string, opts?: ErrorOptions): DomainErrorMapping => ({
  status,
  message,
  json: buildErrorBody(status, message, opts),
})

// Translate a domain error a usecase threw into its HTTP status + AIP-193 body.
// Wired into the global `app.onError`, so handlers `throw` instead of hand-rolling
// per-route try/catch. Returns null for errors we don't translate; `onError` then
// falls back to a generic 500. To support a new domain error: add a branch here.
export function mapDomainError(error: unknown): DomainErrorMapping | null {
  if (error instanceof AppError) {
    return mapping(error.httpStatus as ContentfulStatusCode, error.message, {
      reason: error.meta.reason,
      status: error.meta.canonicalStatus,
      metadata: error.meta.metadata,
    })
  }
  if (error instanceof NameConflictError) {
    const metadata: Record<string, string> = { conflictingName: error.conflictingName }
    if (error.conflictingId) metadata.conflictingId = error.conflictingId
    return mapping(409, error.message, { reason: ErrorReason.NAME_CONFLICT, status: 'ALREADY_EXISTS', metadata })
  }
  if (error instanceof ObjectUploadSessionError) {
    if (error.code === 'storage_failure') {
      return mapping(502, error.message, { reason: error.reason.toUpperCase() })
    }
    if (error.code === 'not_found') {
      return mapping(404, 'Not found', { reason: error.reason.toUpperCase() })
    }
    // The upload queue renders the message verbatim. A flat "Invalid upload
    // session state" hid whether HEAD failed, a CDN rewrote the ETag, or the
    // session was already consumed, so keep the underlying cause visible.
    const reason = error.reason.toUpperCase()
    const detail = error.message && error.message !== error.code ? error.message : 'Invalid upload session state'
    return mapping(409, `${detail} (${reason})`, { reason })
  }
  if (error instanceof WebDavPathError) {
    return mapping(error.status as ContentfulStatusCode, error.message)
  }
  return null
}
