// Single-admin login identifier normalisation.
//
// Better Auth's credential sign-in requires an email-shaped identifier
// (`z.email()` in its sign-in route) and looks users up with
// `email.toLowerCase()`. ZPAN_USERNAME may be a plain username such as
// "admin", so both the startup seed and the sign-in form map it to the same
// reserved synthetic address before Better Auth sees it. This keeps the
// existing `user.email` column and needs no schema change or extra plugin.

export const LOGIN_IDENTIFIER_DOMAIN = 'zpan.local'

const USERNAME_PATTERN = /^[a-z0-9._-]+$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type LoginIdentifier = {
  email: string
  username: string | null
}

/**
 * Returns the lower-cased, email-shaped identifier Better Auth expects, or
 * `null` when the input cannot be used as a login name. Always use this for
 * both seeding and sign-in so the two cannot drift apart.
 */
export function normalizeLoginIdentifier(raw: string): LoginIdentifier | null {
  const value = raw.trim().toLowerCase()
  if (!value) return null

  if (!value.includes('@')) {
    if (!USERNAME_PATTERN.test(value)) return null
    return { email: `${value}@${LOGIN_IDENTIFIER_DOMAIN}`, username: value }
  }

  if (!EMAIL_PATTERN.test(value)) return null
  return { email: value, username: null }
}

/** Inverse for display: a synthetic address is shown as its username. */
export function displayLoginIdentifier(email: string): string {
  const value = email.trim().toLowerCase()
  const suffix = `@${LOGIN_IDENTIFIER_DOMAIN}`
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : email
}
