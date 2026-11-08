import { DEFAULT_SITE_NAME } from '@shared/constants'
import { normalizeLoginIdentifier } from '@shared/login-identifier'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSiteConfig } from '@/hooks/use-site-config'
import { absoluteAuthCallbackURL } from '@/lib/auth-callback'
import { authClient, signIn } from '@/lib/auth-client'
import { isCredentialLoginMethod } from '@/lib/last-login-method'
import { clearSignInRedirect, loadSignInRedirect } from '@/lib/sign-in-redirect'

export const Route = createFileRoute('/(auth)/sign-in')({
  component: SignIn,
})

function SignIn() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [redirectTo] = useState(() =>
    loadSignInRedirect(window.location.search, window.location.origin, window.sessionStorage),
  )
  const callbackURL = absoluteAuthCallbackURL(redirectTo ?? '/files', window.location.origin)
  const { data: siteConfig } = useSiteConfig()
  const siteName = siteConfig?.site.name ?? DEFAULT_SITE_NAME
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const usedCredentialsLast = isCredentialLoginMethod(authClient.getLastUsedLoginMethod())

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    // Better Auth requires an email-shaped identifier. A plain username is
    // mapped to the same synthetic address the startup seed uses.
    const identifier = normalizeLoginIdentifier(email)
    if (!identifier) {
      setError(t('auth.invalidLoginIdentifier'))
      return
    }
    setLoading(true)
    try {
      const result = await signIn.email({ email: identifier.email, password, callbackURL })
      if (result.error) {
        setError(
          result.error.code === 'EMAIL_NOT_VERIFIED'
            ? t('auth.emailNotVerified')
            : (result.error.message ?? t('auth.signInFailed')),
        )
        return
      }
      if (redirectTo) {
        clearSignInRedirect(window.sessionStorage)
        window.location.href = redirectTo
      } else {
        navigate({ to: '/files' })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-6 p-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold">{siteName || DEFAULT_SITE_NAME}</h1>
          <p className="text-muted-foreground">{t('auth.signInSubtitle')}</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t('auth.emailOrUsername')}</Label>
            <Input
              id="email"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('auth.emailOrUsernamePlaceholder')}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Link to="/forgot-password" className="text-xs text-muted-foreground underline hover:text-foreground">
                {t('auth.forgotPassword')}
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="relative w-full" disabled={loading}>
            {loading ? t('auth.signingIn') : t('auth.signIn')}
            {usedCredentialsLast && (
              <span className="absolute right-3 text-xs font-normal text-primary-foreground/70">
                {t('auth.lastUsed')}
              </span>
            )}
          </Button>
        </form>
      </div>
    </div>
  )
}
