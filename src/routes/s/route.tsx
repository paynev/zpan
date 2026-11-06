import { createFileRoute, Outlet } from '@tanstack/react-router'
import { PublicLayout } from '@/components/layout/public-layout'

export const Route = createFileRoute('/s')({
  component: ShareRouteLayout,
})

function ShareRouteLayout() {
  return (
    <PublicLayout>
      <Outlet />
    </PublicLayout>
  )
}
