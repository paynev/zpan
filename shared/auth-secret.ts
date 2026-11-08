// Single-admin instances have exactly one credential pair. Instead of asking
// operators to provision (and back up) a separate random signing secret, derive
// a stable one from those credentials:
//
//   BETTER_AUTH_SECRET = hex(HMAC-SHA256(key = ZPAN_PASSWORD,
//                                       msg = "zpan:better-auth-secret:v1\0" + ZPAN_USERNAME))
//
// The result is a 64-character (256-bit) lowercase hex string. It is stable
// across restarts, isolates and deployment targets as long as the credentials
// stay the same, and rotates automatically when either credential changes.
// The fixed context prefix separates this derivation from every other HMAC use
// in the app (e.g. page tokens).

/** Domain-separation prefix; changing it invalidates every existing session. */
const DERIVATION_CONTEXT = 'zpan:better-auth-secret:v1'

export const AUTH_SECRET_ENV = 'BETTER_AUTH_SECRET'
export const USERNAME_ENV = 'ZPAN_USERNAME'
export const PASSWORD_ENV = 'ZPAN_PASSWORD'

/** Lowercase hex so the derived value is always a predictable 64-char secret. */
function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * Derive the signing secret from the single-admin credentials.
 * Uses Web Crypto so the exact same value is produced on Node and workerd.
 */
export async function deriveAuthSecret(username: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const message = new TextEncoder().encode(`${DERIVATION_CONTEXT}\0${username}`)
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  return toHex(signature)
}

export type EnvReader = (key: string) => string | undefined

// resolveAuthSecret is called on every request (page tokens verify their
// signature there), so memoize the derivation for the current credential pair.
// Only the promise is cached; a changed username/password recomputes it.
let derivedMemo: { input: string; value: Promise<string> } | undefined

/**
 * Resolve the signing secret for the current runtime.
 *
 * An explicitly configured `BETTER_AUTH_SECRET` still wins (keeps existing
 * deployments and test fixtures working); otherwise the value is derived from
 * `ZPAN_USERNAME` / `ZPAN_PASSWORD`. Both callers — auth session signing and
 * page-token signing — must go through this function so they never disagree.
 */
export async function resolveAuthSecret(getEnv: EnvReader): Promise<string> {
  const explicit = getEnv(AUTH_SECRET_ENV)?.trim()
  if (explicit) return explicit

  const username = getEnv(USERNAME_ENV)?.trim()
  const password = getEnv(PASSWORD_ENV)
  if (!username || !password) {
    throw new Error(
      `${USERNAME_ENV} and ${PASSWORD_ENV} are required to derive ${AUTH_SECRET_ENV}. Set both before starting the instance.`,
    )
  }
  const input = `${username}\0${password}`
  if (derivedMemo?.input !== input) {
    derivedMemo = { input, value: deriveAuthSecret(username, password) }
  }
  return derivedMemo.value
}
