import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { displayLoginIdentifier, LOGIN_IDENTIFIER_DOMAIN, normalizeLoginIdentifier } from './login-identifier'

describe('normalizeLoginIdentifier', () => {
  it('maps a plain username to the reserved synthetic address', () => {
    expect(normalizeLoginIdentifier('admin')).toEqual({
      email: `admin@${LOGIN_IDENTIFIER_DOMAIN}`,
      username: 'admin',
    })
  })

  it('trims and lower-cases both usernames and emails', () => {
    expect(normalizeLoginIdentifier('  Admin  ')?.email).toBe(`admin@${LOGIN_IDENTIFIER_DOMAIN}`)
    // Better Auth looks users up with email.toLowerCase(), so an upper-case
    // seeded address would otherwise make sign-in fail with 401.
    expect(normalizeLoginIdentifier(' Admin@Example.COM ')?.email).toBe('admin@example.com')
  })

  it('keeps a full email address apart from case', () => {
    expect(normalizeLoginIdentifier('admin@example.com')).toEqual({
      email: 'admin@example.com',
      username: null,
    })
  })

  it('accepts dots, hyphens and underscores in usernames', () => {
    expect(normalizeLoginIdentifier('a.b-c_d')?.email).toBe(`a.b-c_d@${LOGIN_IDENTIFIER_DOMAIN}`)
  })

  it('rejects empty, whitespace-containing and malformed values', () => {
    expect(normalizeLoginIdentifier('')).toBeNull()
    expect(normalizeLoginIdentifier('   ')).toBeNull()
    expect(normalizeLoginIdentifier('hello world')).toBeNull()
    expect(normalizeLoginIdentifier('admin@')).toBeNull()
    expect(normalizeLoginIdentifier('admin@example')).toBeNull()
    expect(normalizeLoginIdentifier('a@b@c.com')).toBeNull()
    expect(normalizeLoginIdentifier('admin@zpan local')).toBeNull()
  })

  it('always produces an identifier accepted by zod email validation', () => {
    for (const input of ['admin', 'a.b-c_d', 'Admin@Example.com']) {
      const result = normalizeLoginIdentifier(input)
      expect(result).not.toBeNull()
      expect(z.email().safeParse(result?.email).success).toBe(true)
    }
  })
})

describe('displayLoginIdentifier', () => {
  it('shows a synthetic address as its username', () => {
    expect(displayLoginIdentifier(`Admin@${LOGIN_IDENTIFIER_DOMAIN}`)).toBe('admin')
  })

  it('leaves real email addresses untouched', () => {
    expect(displayLoginIdentifier('Admin@Example.com')).toBe('Admin@Example.com')
  })
})
