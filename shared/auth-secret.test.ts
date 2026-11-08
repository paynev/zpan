import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AUTH_SECRET_ENV, deriveAuthSecret, PASSWORD_ENV, resolveAuthSecret, USERNAME_ENV } from './auth-secret'

const username = 'admin@example.com'
const password = 'correct horse battery staple'

function env(values: Record<string, string | undefined>) {
  return (key: string) => values[key]
}

describe('deriveAuthSecret', () => {
  it('produces a stable 64-character lowercase hex secret', async () => {
    const secret = await deriveAuthSecret(username, password)
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(await deriveAuthSecret(username, password)).toBe(secret)
  })

  it('is exactly HMAC-SHA256(password, context + NUL + username) in hex', async () => {
    const expected = createHmac('sha256', password).update(`zpan:better-auth-secret:v1\0${username}`).digest('hex')
    expect(await deriveAuthSecret(username, password)).toBe(expected)
  })

  it('changes when either credential changes', async () => {
    const original = await deriveAuthSecret(username, password)
    expect(await deriveAuthSecret('other@example.com', password)).not.toBe(original)
    expect(await deriveAuthSecret(username, 'different-password')).not.toBe(original)
  })
})

describe('resolveAuthSecret', () => {
  it('derives from ZPAN_USERNAME / ZPAN_PASSWORD when no explicit secret is set', async () => {
    const getEnv = env({ [USERNAME_ENV]: username, [PASSWORD_ENV]: password })
    expect(await resolveAuthSecret(getEnv)).toBe(await deriveAuthSecret(username, password))
  })

  it('lets an explicit BETTER_AUTH_SECRET win', async () => {
    const getEnv = env({
      [USERNAME_ENV]: username,
      [PASSWORD_ENV]: password,
      [AUTH_SECRET_ENV]: 'explicit-secret',
    })
    expect(await resolveAuthSecret(getEnv)).toBe('explicit-secret')
  })

  it('trims the username before deriving', async () => {
    const padded = env({ [USERNAME_ENV]: `  ${username}  `, [PASSWORD_ENV]: password })
    const plain = env({ [USERNAME_ENV]: username, [PASSWORD_ENV]: password })
    expect(await resolveAuthSecret(padded)).toBe(await resolveAuthSecret(plain))
  })

  it('rejects missing or blank credentials with an actionable message', async () => {
    const cases = [
      {},
      { [USERNAME_ENV]: username },
      { [PASSWORD_ENV]: password },
      { [USERNAME_ENV]: '   ', [PASSWORD_ENV]: password },
      { [USERNAME_ENV]: username, [PASSWORD_ENV]: '' },
    ]
    for (const values of cases) {
      await expect(resolveAuthSecret(env(values))).rejects.toThrow(
        'ZPAN_USERNAME and ZPAN_PASSWORD are required to derive BETTER_AUTH_SECRET',
      )
    }
  })

  it('recomputes after credentials change instead of reusing a cached derivation', async () => {
    const first = await resolveAuthSecret(env({ [USERNAME_ENV]: username, [PASSWORD_ENV]: password }))
    const second = await resolveAuthSecret(env({ [USERNAME_ENV]: username, [PASSWORD_ENV]: 'rotated' }))
    const back = await resolveAuthSecret(env({ [USERNAME_ENV]: username, [PASSWORD_ENV]: password }))
    expect(second).not.toBe(first)
    expect(back).toBe(first)
  })
})
