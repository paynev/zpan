/**
 * Cloudflare Workers derive `request.url` from the Host header. A CDN or
 * reverse proxy that rewrites Host to the origin hostname therefore hides the
 * hostname the browser actually used. Better Auth validates both the `Origin`
 * header and `callbackURL` against `trustedOrigins`, so a proxied deployment
 * must trust the *public* origin instead of the origin-side one.
 *
 * The public origin is derived from proxy headers (never from a page-supplied
 * value), so a different CDN hostname works without redeploying or setting
 * BETTER_AUTH_URL / TRUSTED_ORIGINS by hand.
 */

const FORWARDED_HOST_HEADER = 'x-forwarded-host'
const FORWARDED_PROTO_HEADER = 'x-forwarded-proto'
const FORWARDED_HEADER = 'forwarded'
const CF_VISITOR_HEADER = 'cf-visitor'

function firstHeaderValue(value: string | null): string | null {
  if (!value) return null
  return value.split(',')[0]?.trim() || null
}

function forwardedParam(header: string | null, key: 'host' | 'proto'): string | null {
  const forwarded = firstHeaderValue(header)
  if (!forwarded) return null
  for (const segment of forwarded.split(';')) {
    const [name, rawValue] = segment.split('=')
    if (name?.trim().toLowerCase() !== key) continue
    return rawValue?.trim().replace(/^"|"$/g, '') || null
  }
  return null
}

function cloudflareVisitorProtocol(header: string | null): string | null {
  if (!header) return null
  try {
    const scheme = (JSON.parse(header) as { scheme?: unknown }).scheme
    return scheme === 'http' || scheme === 'https' ? scheme : null
  } catch {
    return null
  }
}

export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

function uniqueOrigins(values: Iterable<string | null>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value)))]
}

/** Resolve the origin a browser sees, including when a CDN rewrites Host. */
export function publicRequestOrigin(request: Request): string {
  const requestUrl = new URL(request.url)
  const fallbackProtocol = requestUrl.protocol === 'http:' ? 'http' : 'https'
  const protocol =
    firstHeaderValue(request.headers.get(FORWARDED_PROTO_HEADER)) ??
    forwardedParam(request.headers.get(FORWARDED_HEADER), 'proto') ??
    cloudflareVisitorProtocol(request.headers.get(CF_VISITOR_HEADER)) ??
    fallbackProtocol
  const safeProtocol = protocol === 'http' || protocol === 'https' ? protocol : fallbackProtocol
  const host =
    firstHeaderValue(request.headers.get(FORWARDED_HOST_HEADER)) ??
    forwardedParam(request.headers.get(FORWARDED_HEADER), 'host') ??
    firstHeaderValue(request.headers.get('host')) ??
    requestUrl.host

  // Reject paths, userinfo and whitespace before building a URL from a header.
  if (/[\s/@?#\\]/.test(host)) return requestUrl.origin
  return normalizeOrigin(`${safeProtocol}://${host}`) ?? requestUrl.origin
}

export interface DynamicTrustedOriginsOptions {
  /**
   * Trust the browser-supplied `Origin` header as a last resort, for proxies
   * that rewrite Host without sending any forwarded-host header. Browsers set
   * Origin themselves, and session cookies stay host-only + SameSite=Lax.
   * Set ZPAN_TRUST_REQUEST_ORIGIN=false to disable this fallback.
   */
  trustRequestOrigin?: boolean
}

/**
 * Build a Better Auth `trustedOrigins` resolver. Static values cover configured
 * URLs; the per-request values let any CDN hostname sign in without a rebuild.
 */
export function createDynamicTrustedOrigins(
  staticOrigins: readonly (string | null | undefined)[],
  options: DynamicTrustedOriginsOptions = {},
): (request?: Request) => string[] {
  const staticList = uniqueOrigins(staticOrigins.map(normalizeOrigin))
  const trustRequestOrigin = options.trustRequestOrigin ?? true

  return (request) => {
    if (!request) return staticList
    const perRequest = [publicRequestOrigin(request), normalizeOrigin(new URL(request.url).origin)]
    if (trustRequestOrigin) perRequest.push(normalizeOrigin(request.headers.get('origin')))
    return uniqueOrigins([...staticList, ...perRequest])
  }
}
