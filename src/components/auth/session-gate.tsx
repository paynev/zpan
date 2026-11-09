import { AlertCircle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ApiError } from '@/lib/api'

export function SessionGatePending() {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="space-y-3 text-center">
        <Loader2 className="mx-auto size-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('auth.session.loading')}</p>
      </div>
    </div>
  )
}

// The Worker answers 503 `{ error: 'instance_not_configured', message, hint }`
// when no admin credentials are configured. Surface the setup hint instead of
// the generic "server did not respond" text, so the home page tells the
// operator exactly what to configure.
function instanceNotConfiguredHint(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  if (error.status !== 503) return undefined
  if (error.body.error.message !== 'instance_not_configured' && error.reason !== 'instance_not_configured') {
    return undefined
  }
  return error.metadata?.hint
}

export function SessionGateError({ error, reset }: { error?: unknown; reset: () => void }) {
  const { t } = useTranslation()
  const hint = instanceNotConfiguredHint(error)

  if (hint) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
        <div className="w-full max-w-lg space-y-4 text-center">
          <AlertCircle className="mx-auto size-10 text-amber-500" />
          <div className="space-y-2">
            <h2 className="text-xl font-semibold">{t('auth.session.setupRequiredTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('auth.session.setupRequiredDescription')}</p>
          </div>
          <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3 text-left font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {hint}
          </pre>
          <Button onClick={reset}>{t('auth.session.retry')}</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <AlertCircle className="mx-auto size-10 text-destructive" />
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">{t('auth.session.errorTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('auth.session.errorDescription')}</p>
        </div>
        <Button onClick={reset}>{t('auth.session.retry')}</Button>
      </div>
    </div>
  )
}
