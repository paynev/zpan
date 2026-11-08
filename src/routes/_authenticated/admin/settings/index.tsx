import { zodResolver } from '@hookform/resolvers/zod'
import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_NAME } from '@shared/constants'
import type { SiteSettings } from '@shared/schemas'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Globe2, Network } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'
import { AdminFormDrawer, AdminFormField, AdminSwitchField } from '@/components/admin/admin-form-drawer'
import { AdminPageHeader } from '@/components/admin/admin-page-header'
import { BrandingSection } from '@/components/admin/branding-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { siteConfigQueryKey } from '@/hooks/use-site-config'
import { siteSettingsQueryKey, useSiteSettings } from '@/hooks/use-site-settings'
import { updateSiteIdentity, updateSiteWebDav, verifySiteWebDav } from '@/lib/api'

export const Route = createFileRoute('/_authenticated/admin/settings/')({
  component: SettingsPage,
})

const settingsSchema = z.object({
  siteName: z.string().min(1),
  siteDescription: z.string(),
  sitePublicOrigin: z
    .string()
    .trim()
    .url('Site URL must be a valid URL')
    .refine((value) => {
      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.pathname === '/' &&
        url.search === '' &&
        url.hash === ''
      )
    }, 'Site URL must be an HTTP or HTTPS origin without a path, query, or fragment'),
  webdavEnabled: z.boolean(),
  webdavDomain: z.string(),
})

type SettingsFormValues = z.infer<typeof settingsSchema>
type SettingsDrawer = 'identity' | 'webdav' | null

function SettingsItemCard({
  icon,
  title,
  description,
  details,
  status,
  editLabel,
  onEdit,
}: {
  icon: ReactNode
  title: ReactNode
  description: ReactNode
  details?: ReactNode
  status?: ReactNode
  editLabel: string
  onEdit: () => void
}) {
  return (
    <Card data-settings-row className="rounded-lg border-border/70 py-0 shadow-xs">
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted text-muted-foreground">
            {icon}
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-sm leading-5">{title}</CardTitle>
            <CardDescription className="max-w-2xl leading-5">{description}</CardDescription>
            {details && <div className="text-sm text-muted-foreground">{details}</div>}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
          {status}
          <Button size="sm" variant="outline" onClick={onEdit}>
            {editLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function SettingsSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-muted-foreground text-xs font-medium uppercase">{title}</h3>
      <div className="grid gap-2">{children}</div>
    </section>
  )
}

export function SettingsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [settingsDrawer, setSettingsDrawer] = useState<SettingsDrawer>(null)
  const { data: settings, isLoading } = useSiteSettings()
  const siteName = settings?.identity.name ?? DEFAULT_SITE_NAME
  const siteDescription = settings?.identity.description ?? DEFAULT_SITE_DESCRIPTION
  const sitePublicOrigin = settings?.identity.publicUrl ?? ''
  const webdav = settings?.webdav

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      siteName: '',
      siteDescription: '',
      sitePublicOrigin: '',
      webdavEnabled: true,
      webdavDomain: '',
    },
  })

  const savedSettingsValues = useCallback(
    (): SettingsFormValues => ({
      siteName,
      siteDescription,
      sitePublicOrigin,
      webdavEnabled: webdav?.enabled ?? true,
      webdavDomain: webdav?.domain ?? '',
    }),
    [siteName, siteDescription, sitePublicOrigin, webdav?.enabled, webdav?.domain],
  )

  const closeSettingsDrawer = useCallback(
    ({ reset = true }: { reset?: boolean } = {}) => {
      setSettingsDrawer(null)
      if (reset) form.reset(savedSettingsValues())
    },
    [form, savedSettingsValues],
  )

  useEffect(() => {
    if (isLoading) return
    form.reset(savedSettingsValues())
  }, [isLoading, form, savedSettingsValues])

  const identityMutation = useMutation({
    mutationFn: async () => {
      const valid = await form.trigger(['siteName', 'siteDescription', 'sitePublicOrigin'])
      if (!valid) throw new Error(t('admin.settings.identityInvalid'))
      const values = form.getValues()
      await updateSiteIdentity({
        name: values.siteName,
        description: values.siteDescription,
        publicUrl: values.sitePublicOrigin.trim(),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: siteSettingsQueryKey })
      queryClient.invalidateQueries({ queryKey: siteConfigQueryKey })
      closeSettingsDrawer({ reset: false })
      toast.success(t('admin.settings.saved'))
    },
    onError: (err) => toast.error(err.message),
  })

  const webdavMutation = useMutation({
    mutationFn: async () => {
      const values = form.getValues()
      const domain = values.webdavDomain.trim().toLowerCase()
      if (
        domain &&
        (domain.length > 253 ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(domain))
      ) {
        form.setError('webdavDomain', { message: t('admin.settings.webdavDomainInvalid') })
        throw new Error(t('admin.settings.webdavDomainInvalid'))
      }
      return updateSiteWebDav({ enabled: values.webdavEnabled, domain })
    },
    onSuccess: (result) => {
      queryClient.setQueryData<SiteSettings>(siteSettingsQueryKey, (current) =>
        current ? { ...current, webdav: result } : current,
      )
      queryClient.invalidateQueries({ queryKey: siteSettingsQueryKey })
      queryClient.invalidateQueries({ queryKey: siteConfigQueryKey })
      form.reset({ ...form.getValues(), webdavEnabled: result.enabled, webdavDomain: result.domain })
      toast.success(t('admin.settings.saved'))
    },
    onError: (err) => toast.error(err.message),
  })

  const webdavVerificationMutation = useMutation({
    mutationFn: verifySiteWebDav,
    onSuccess: (result) => {
      queryClient.setQueryData<SiteSettings>(siteSettingsQueryKey, (current) =>
        current ? { ...current, webdav: result } : current,
      )
      queryClient.invalidateQueries({ queryKey: siteSettingsQueryKey })
      toast.success(t('admin.settings.saved'))
    },
    onError: (err) => toast.error(err.message),
  })

  const configuredWebdavEnabled = form.watch('webdavEnabled')

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <p>{t('common.loading')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <AdminPageHeader title={t('admin.settings.title')} description={t('admin.settings.subtitle')} />

      <div className="space-y-5">
        <SettingsSection title={t('admin.settings.siteSection')}>
          <SettingsItemCard
            icon={<Globe2 className="size-4" />}
            title={t('admin.settings.identityTitle')}
            description={t('admin.settings.identityDescription')}
            details={
              <span>
                {siteName} · {sitePublicOrigin || t('admin.settings.sitePublicOriginPlaceholder')}
              </span>
            }
            editLabel={t('common.edit')}
            onEdit={() => setSettingsDrawer('identity')}
          />
          <BrandingSection />
        </SettingsSection>

        <SettingsSection title={t('admin.settings.webdavSection')}>
          <SettingsItemCard
            icon={<Network className="size-4" />}
            title={t('admin.settings.webdavTitle')}
            description={t('admin.settings.webdavDescription')}
            details={
              webdav?.enabled
                ? webdav.status === 'ready'
                  ? webdav.candidateUrl
                  : webdav.pathUrl
                : t('common.disabled')
            }
            status={
              <Badge
                variant={
                  webdav?.status === 'ready' ? 'default' : webdav?.status === 'failed' ? 'destructive' : 'secondary'
                }
              >
                {t(`admin.settings.webdavStatus.${webdav?.status ?? 'unverified'}`)}
              </Badge>
            }
            editLabel={t('admin.settings.webdavDetails')}
            onEdit={() => setSettingsDrawer('webdav')}
          />
        </SettingsSection>
      </div>

      <AdminFormDrawer
        open={settingsDrawer === 'identity'}
        onOpenChange={(open) => !open && closeSettingsDrawer()}
        title={t('admin.settings.identityTitle')}
        description={t('admin.settings.identityDescription')}
        bodyClassName="grid auto-rows-min content-start gap-4"
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => closeSettingsDrawer()}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled={identityMutation.isPending} onClick={() => identityMutation.mutate()}>
              {identityMutation.isPending ? t('common.loading') : t('common.save')}
            </Button>
          </>
        }
      >
        <AdminFormField
          id="siteName"
          label={t('admin.settings.siteName')}
          help={t('admin.settings.siteNameHint')}
          required
          error={form.formState.errors.siteName?.message}
        >
          <Input placeholder={t('admin.settings.siteNamePlaceholder')} {...form.register('siteName')} />
        </AdminFormField>
        <AdminFormField
          id="siteDescription"
          label={t('admin.settings.siteDescription')}
          help={t('admin.settings.siteDescriptionHint')}
          error={form.formState.errors.siteDescription?.message}
        >
          <Textarea
            rows={4}
            placeholder={t('admin.settings.siteDescriptionPlaceholder')}
            {...form.register('siteDescription')}
          />
        </AdminFormField>
        <AdminFormField
          id="sitePublicOrigin"
          label={t('admin.settings.sitePublicOrigin')}
          help={t('admin.settings.sitePublicOriginHint')}
          error={form.formState.errors.sitePublicOrigin?.message}
        >
          <Input placeholder={t('admin.settings.sitePublicOriginPlaceholder')} {...form.register('sitePublicOrigin')} />
        </AdminFormField>
      </AdminFormDrawer>

      <AdminFormDrawer
        open={settingsDrawer === 'webdav'}
        onOpenChange={(open) => !open && closeSettingsDrawer()}
        title={t('admin.settings.webdavTitle')}
        description={t('admin.settings.webdavDrawerDescription')}
        bodyClassName="grid auto-rows-min content-start gap-4"
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => closeSettingsDrawer()}>
              {t('common.close')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                !webdav?.enabled ||
                !webdav.candidateUrl ||
                form.formState.isDirty ||
                webdavVerificationMutation.isPending
              }
              onClick={() => webdavVerificationMutation.mutate()}
            >
              {webdavVerificationMutation.isPending
                ? t('admin.settings.webdavVerifying')
                : t('admin.settings.webdavVerify')}
            </Button>
            <Button type="button" disabled={webdavMutation.isPending} onClick={() => webdavMutation.mutate()}>
              {webdavMutation.isPending ? t('common.loading') : t('common.save')}
            </Button>
          </>
        }
      >
        <AdminSwitchField
          id="webdavEnabled"
          label={t('admin.settings.webdavEnabled')}
          description={t('admin.settings.webdavEnabledHint')}
          checked={configuredWebdavEnabled}
          disabled={webdavMutation.isPending}
          onCheckedChange={(checked) => form.setValue('webdavEnabled', checked, { shouldDirty: true })}
        />
        <AdminFormField
          id="webdavDomain"
          label={t('admin.settings.webdavDomain')}
          help={t('admin.settings.webdavDomainHint')}
          error={form.formState.errors.webdavDomain?.message}
          className={!configuredWebdavEnabled ? 'opacity-60' : undefined}
        >
          <Input
            disabled={!configuredWebdavEnabled}
            placeholder={t('admin.settings.webdavDomainPlaceholder')}
            {...form.register('webdavDomain')}
          />
        </AdminFormField>
        <AdminFormField
          id="webdavPathUrl"
          label={t('admin.settings.webdavPathUrl')}
          help={t('admin.settings.webdavPathUrlHint')}
        >
          <Input id="webdavPathUrl" readOnly value={webdav?.pathUrl ?? ''} />
        </AdminFormField>
        <AdminFormField
          id="webdavCandidateUrl"
          label={t('admin.settings.webdavCandidateUrl')}
          help={t('admin.settings.webdavCandidateUrlHint')}
        >
          <Input id="webdavCandidateUrl" readOnly value={webdav?.candidateUrl ?? ''} />
        </AdminFormField>
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{t('admin.settings.webdavVerificationStatus')}</span>
            <Badge
              variant={
                webdav?.status === 'ready' ? 'default' : webdav?.status === 'failed' ? 'destructive' : 'secondary'
              }
            >
              {t(`admin.settings.webdavStatus.${webdav?.status ?? 'unverified'}`)}
            </Badge>
          </div>
          {webdav?.lastVerifiedAt && (
            <p className="mt-2 text-muted-foreground">
              {t('admin.settings.webdavLastVerified', { value: new Date(webdav.lastVerifiedAt).toLocaleString() })}
            </p>
          )}
          {webdav?.error && <p className="mt-2 text-destructive">{webdav.error}</p>}
        </div>
        <p className="text-muted-foreground text-xs leading-5">{t('admin.settings.webdavVerificationHint')}</p>
      </AdminFormDrawer>
    </div>
  )
}
