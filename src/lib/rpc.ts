import type {
  AuthedSharesRoute,
  BrandingAdminRoute,
  ConfigzRoute,
  EventsRoute,
  NotificationsRoute,
  ObjectsRoute,
  PublicSharesRoute,
  SiteSettingsRoute,
  StoragesRoute,
  SystemRoute,
  TrashRoute,
} from '@server/app'
import { hc } from 'hono/client'

const opts = { init: { credentials: 'include' as RequestCredentials } }
const absoluteUrlBase = (path: string) => {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  return new URL(path, origin).toString()
}

export const objects = hc<ObjectsRoute>('/api/objects', opts)
export const trash = hc<TrashRoute>('/api/trash', opts)
export const storages = hc<StoragesRoute>('/api/site/storages', opts)
export const system = hc<SystemRoute>('/api/site', opts)
export const configzApi = hc<ConfigzRoute>('/api/configz', opts)
export const siteSettingsApi = hc<SiteSettingsRoute>('/api/site/settings', opts)
export const notificationsApi = hc<NotificationsRoute>('/api/notifications', opts)
export const eventsUrlApi = hc<EventsRoute>(absoluteUrlBase('/api/events'), opts)

// Shares are a single resource; separate clients only because Hono RPC types
// are split across two sub-apps (public vs. authed) mounted at the same path.
export const publicSharesApi = hc<PublicSharesRoute>('/api/shares', opts)
export const authedSharesApi = hc<AuthedSharesRoute>('/api/shares', opts)

export const brandingAdminApi = hc<BrandingAdminRoute>('/api/site/settings/branding', opts)
