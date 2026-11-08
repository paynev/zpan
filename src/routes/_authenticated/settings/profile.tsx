import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { authClient, useSession } from '@/lib/auth-client'

export const Route = createFileRoute('/_authenticated/settings/profile')({
  component: ProfilePage,
})

const profileSchema = z.object({
  displayName: z.string().min(1).max(100),
})

type ProfileFormValues = z.infer<typeof profileSchema>

function DisplayNameCard() {
  const { t } = useTranslation()
  const { data: session } = useSession()

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { displayName: '' },
  })

  useEffect(() => {
    if (session?.user?.name) {
      form.reset({ displayName: session.user.name })
    }
  }, [session?.user?.name, form])

  const mutation = useMutation({
    mutationFn: async (values: ProfileFormValues) => {
      const { error } = await authClient.updateUser({ name: values.displayName })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success(t('settings.profile.saved'))
      form.reset(form.getValues())
    },
    onError: (err) => toast.error(err.message ?? String(err)),
  })

  return (
    <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))}>
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.profile.displayName')}</CardTitle>
          <CardDescription>{t('settings.profile.displayName.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Input {...form.register('displayName')} maxLength={100} />
          {form.formState.errors.displayName && (
            <p className="mt-1.5 text-xs text-destructive">{form.formState.errors.displayName.message}</p>
          )}
        </CardContent>
        <CardFooter className="justify-between border-t bg-muted/30">
          <p className="text-sm text-muted-foreground">{t('settings.profile.displayName.hint')}</p>
          <Button type="submit" size="sm" disabled={!form.formState.isDirty || mutation.isPending}>
            {mutation.isPending ? t('common.loading') : t('common.save')}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}

export function UsernameCard() {
  const { t } = useTranslation()
  const { data: session } = useSession()
  const username = (session?.user as { username?: string })?.username ?? ''

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.profile.username')}</CardTitle>
        <CardDescription>{t('settings.profile.username.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex">
          <span className="inline-flex select-none items-center rounded-l-md border border-r-0 bg-muted px-3 text-sm text-muted-foreground">
            @
          </span>
          <Input value={username} disabled className="rounded-l-none" />
        </div>
      </CardContent>
      <CardFooter className="justify-between border-t bg-muted/30">
        <p className="text-sm text-muted-foreground">{t('settings.profile.username.hint')}</p>
        {username && (
          <Button asChild variant="outline" size="sm">
            <a href={`/u/${username}`} target="_blank" rel="noopener noreferrer">
              {t('settings.profile.publicHomepage')}
              <ExternalLink />
            </a>
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

function EmailCard() {
  const { t } = useTranslation()
  const { data: session } = useSession()
  const email = session?.user?.email ?? ''

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.profile.email')}</CardTitle>
        <CardDescription>{t('settings.profile.email.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Input value={email} disabled />
      </CardContent>
      <CardFooter className="border-t bg-muted/30">
        <p className="text-sm text-muted-foreground">{t('settings.profile.emailReadonly')}</p>
      </CardFooter>
    </Card>
  )
}

function ProfilePage() {
  return (
    <div className="max-w-2xl space-y-6">
      <DisplayNameCard />
      <UsernameCard />
      <EmailCard />
    </div>
  )
}
