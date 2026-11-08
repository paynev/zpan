import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_NAME } from '@shared/constants'
import type { SiteBranding, SiteConfig } from '@shared/schemas'
import { normalizePublicOrigin } from '../../domain/site-public-origin'
import { effectiveWebDavUrl } from '../../domain/webdav-public-url'
import type { CacheService, SystemOptionsRepo } from '../ports'
import { readBranding } from './branding'
import { SITE_CONFIG_CACHE_KEY, SITE_CONFIG_CACHE_POLICY } from './config-cache'
import { SITE_SETTING_KEYS } from './setting-keys'

export type ConfigzDeps = {
  systemOptions: SystemOptionsRepo
  cache?: CacheService
}

const CONFIG_KEYS = [
  SITE_SETTING_KEYS.name,
  SITE_SETTING_KEYS.description,
  SITE_SETTING_KEYS.publicOrigin,
  SITE_SETTING_KEYS.webdavEnabled,
  SITE_SETTING_KEYS.webdavDomain,
  SITE_SETTING_KEYS.webdavVerifiedOrigin,
]

function brandingView(config: Awaited<ReturnType<typeof readBranding>>): SiteBranding {
  return {
    logoUrl: config.logo_url,
    faviconUrl: config.favicon_url,
    wordmark: config.wordmark_text,
    hidePoweredBy: config.hide_powered_by,
    theme: {
      mode: config.theme.mode,
      preset: config.theme.preset,
      custom: config.theme.custom
        ? {
            primaryColor: config.theme.custom.primary_color,
            primaryForeground: config.theme.custom.primary_foreground,
            canvasColor: config.theme.custom.canvas_color,
            sidebarAccentColor: config.theme.custom.sidebar_accent_color,
            ringColor: config.theme.custom.ring_color,
          }
        : null,
      configured: config.theme.configured,
    },
  }
}

async function loadSiteConfig(deps: ConfigzDeps, requestUrl: string): Promise<SiteConfig> {
  const [rows, branding] = await Promise.all([deps.systemOptions.getMany(CONFIG_KEYS), readBranding(deps)])
  const values = new Map(rows.map((row) => [row.key, row.value]))
  const publicUrl = normalizePublicOrigin(values.get(SITE_SETTING_KEYS.publicOrigin)) ?? new URL(requestUrl).origin

  return {
    site: {
      name: values.get(SITE_SETTING_KEYS.name) ?? DEFAULT_SITE_NAME,
      description: values.get(SITE_SETTING_KEYS.description) ?? DEFAULT_SITE_DESCRIPTION,
      publicUrl,
    },
    branding: brandingView(branding),
    services: {
      webdav: {
        enabled: values.get(SITE_SETTING_KEYS.webdavEnabled) !== 'false',
        url: effectiveWebDavUrl(
          requestUrl,
          publicUrl,
          values.get(SITE_SETTING_KEYS.webdavVerifiedOrigin),
          values.get(SITE_SETTING_KEYS.webdavDomain),
        ),
      },
    },
  }
}

export async function getSiteConfig(deps: ConfigzDeps, requestUrl: string): Promise<SiteConfig> {
  if (!deps.cache) return loadSiteConfig(deps, requestUrl)
  return (
    await deps.cache.getOrLoad(SITE_CONFIG_CACHE_POLICY, SITE_CONFIG_CACHE_KEY, () => loadSiteConfig(deps, requestUrl))
  ).value
}
