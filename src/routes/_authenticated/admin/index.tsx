import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/admin/')({
  beforeLoad: redirectToAdminSettings,
})

export function redirectToAdminSettings() {
  throw redirect({ to: '/admin/settings' })
}
