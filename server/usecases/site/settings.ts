import { DEFAULT_SITE_DESCRIPTION, DEFAULT_SITE_NAME } from '@shared/constants'
import type {
  SiteIdentitySettings,
  SiteSettings,
  SiteWebDavSettings,
  UpdateSiteIdentityInput,
  UpdateSiteWebDavInput,
} from '@shared/schemas'
import { normalizePublicOrigin } from '../../domain/site-public-origin'
import { WEBDAV_AUTH_CHALLENGE, webDavPathUrl, webDavPublicUrl } from '../../domain/webdav-public-url'
import { badRequest, type CacheService, type SystemOptionsRepo } from '../ports'
import { invalidateSiteConfig } from './config-cache'
import { getSiteRoutingConfig, refreshSiteRoutingConfig } from './routing-config'
import { SITE_SETTING_KEYS } from './setting-keys'

export { SITE_SETTING_KEYS } from './setting-keys'

const ALL_SETTING_KEYS = Object.values(SITE_SETTING_KEYS)

export type SiteSettingsDeps = {
  systemOptions: SystemOptionsRepo
  cache?: CacheService
}

function optionMap(rows: Array<{ key: string; value: string }>): Map<string, string> {
  return new Map(rows.map((row) => [row.key, row.value]))
}

function identityFrom(values: Map<string, string>, requestUrl: string): SiteIdentitySettings {
  return {
    name: values.get(SITE_SETTING_KEYS.name) ?? DEFAULT_SITE_NAME,
    description: values.get(SITE_SETTING_KEYS.description) ?? DEFAULT_SITE_DESCRIPTION,
    publicUrl: normalizePublicOrigin(values.get(SITE_SETTING_KEYS.publicOrigin)) ?? new URL(requestUrl).origin,
  }
}

function webdavFrom(values: Map<string, string>, requestUrl: string): SiteWebDavSettings {
  const publicUrl = normalizePublicOrigin(values.get(SITE_SETTING_KEYS.publicOrigin)) ?? new URL(requestUrl).origin
  const enabled = isWebDavEnabled(values)
  const domain = values.get(SITE_SETTING_KEYS.webdavDomain)?.trim() ?? ''
  const candidate = webDavPublicUrl(publicUrl, domain)
  const verifiedOrigin = normalizePublicOrigin(values.get(SITE_SETTING_KEYS.webdavVerifiedOrigin))
  const error = values.get(SITE_SETTING_KEYS.webdavVerificationError)?.trim() || null
  const ready = candidate !== null && candidate.origin === verifiedOrigin
  const lastVerifiedAt = ready ? values.get(SITE_SETTING_KEYS.webdavVerifiedAt)?.trim() || null : null

  return {
    enabled,
    domain,
    pathUrl: webDavPathUrl(requestUrl, publicUrl),
    candidateUrl: candidate ? `${candidate.origin}/` : null,
    status: enabled ? (ready ? 'ready' : error ? 'failed' : 'unverified') : 'disabled',
    lastVerifiedAt,
    error: enabled && !ready ? error : null,
  }
}

function isWebDavEnabled(values: Map<string, string>): boolean {
  return values.get(SITE_SETTING_KEYS.webdavEnabled) !== 'false'
}

export async function getSiteWebDavRuntimeConfig(
  deps: Pick<SiteSettingsDeps, 'systemOptions' | 'cache'>,
): Promise<{ enabled: boolean; domain: string }> {
  const config = await getSiteRoutingConfig(deps)
  return {
    enabled: config.webDavEnabled,
    domain: config.webDavDomain,
  }
}

export async function getSiteSettings(
  deps: Pick<SiteSettingsDeps, 'systemOptions'>,
  requestUrl: string,
): Promise<SiteSettings> {
  const values = optionMap(await deps.systemOptions.getMany(ALL_SETTING_KEYS))
  return {
    identity: identityFrom(values, requestUrl),
    webdav: webdavFrom(values, requestUrl),
  }
}

export async function updateSiteIdentity(
  deps: SiteSettingsDeps,
  input: UpdateSiteIdentityInput,
): Promise<SiteIdentitySettings> {
  const publicUrl = normalizePublicOrigin(input.publicUrl)
  if (!publicUrl) throw badRequest('Public URL must be an HTTP or HTTPS origin')

  const current = optionMap(
    await deps.systemOptions.getMany([
      SITE_SETTING_KEYS.name,
      SITE_SETTING_KEYS.description,
      SITE_SETTING_KEYS.publicOrigin,
    ]),
  )
  const publicUrlChanged = normalizePublicOrigin(current.get(SITE_SETTING_KEYS.publicOrigin)) !== publicUrl
  await deps.systemOptions.setMany([
    { key: SITE_SETTING_KEYS.name, value: input.name },
    { key: SITE_SETTING_KEYS.description, value: input.description },
    { key: SITE_SETTING_KEYS.publicOrigin, value: publicUrl },
    ...(publicUrlChanged
      ? [
          { key: SITE_SETTING_KEYS.webdavVerifiedOrigin, value: '' },
          { key: SITE_SETTING_KEYS.webdavVerifiedAt, value: '' },
          { key: SITE_SETTING_KEYS.webdavVerificationError, value: '' },
        ]
      : []),
  ])
  await refreshSiteRoutingConfig(deps)
  await invalidateSiteConfig(deps)
  return { ...input, publicUrl }
}

export async function verifySiteWebDav(
  deps: Pick<SiteSettingsDeps, 'systemOptions' | 'cache'>,
  requestUrl: string,
  fetcher: typeof fetch,
): Promise<SiteWebDavSettings> {
  const values = optionMap(await deps.systemOptions.getMany(ALL_SETTING_KEYS))
  const current = webdavFrom(values, requestUrl)
  if (!current.enabled) throw badRequest('WebDAV must be enabled before its domain can be verified')
  const candidate = current.candidateUrl
  let error: string | null = null

  await deps.systemOptions.setMany([
    { key: SITE_SETTING_KEYS.webdavVerifiedOrigin, value: '' },
    { key: SITE_SETTING_KEYS.webdavVerifiedAt, value: '' },
    { key: SITE_SETTING_KEYS.webdavVerificationError, value: '' },
  ])

  if (!candidate) {
    error = 'The Public URL must use a hostname before a WebDAV domain can be verified.'
  } else {
    try {
      const response = await fetcher(candidate, {
        method: 'OPTIONS',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status !== 401 || response.headers.get('WWW-Authenticate') !== WEBDAV_AUTH_CHALLENGE) {
        error = `WebDAV verification returned HTTP ${response.status} without the expected authentication challenge.`
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'WebDAV verification request failed.'
    }
  }

  const verifiedAt = error ? '' : new Date().toISOString()
  await deps.systemOptions.setMany([
    { key: SITE_SETTING_KEYS.webdavVerifiedOrigin, value: error || !candidate ? '' : new URL(candidate).origin },
    { key: SITE_SETTING_KEYS.webdavVerifiedAt, value: verifiedAt },
    { key: SITE_SETTING_KEYS.webdavVerificationError, value: error ?? '' },
  ])
  await invalidateSiteConfig(deps)
  const updatedValues = optionMap(await deps.systemOptions.getMany(ALL_SETTING_KEYS))
  return webdavFrom(updatedValues, requestUrl)
}

export async function updateSiteWebDav(
  deps: Pick<SiteSettingsDeps, 'systemOptions' | 'cache'>,
  input: UpdateSiteWebDavInput,
  requestUrl: string,
): Promise<SiteWebDavSettings> {
  const domain = input.domain.trim().toLowerCase()
  const currentDomain = (await deps.systemOptions.getValue(SITE_SETTING_KEYS.webdavDomain))?.trim() ?? ''
  const domainChanged = currentDomain !== domain

  await deps.systemOptions.setMany([
    { key: SITE_SETTING_KEYS.webdavEnabled, value: String(input.enabled) },
    { key: SITE_SETTING_KEYS.webdavDomain, value: domain },
    ...(domainChanged
      ? [
          { key: SITE_SETTING_KEYS.webdavVerifiedOrigin, value: '' },
          { key: SITE_SETTING_KEYS.webdavVerifiedAt, value: '' },
          { key: SITE_SETTING_KEYS.webdavVerificationError, value: '' },
        ]
      : []),
  ])
  await refreshSiteRoutingConfig(deps)
  await invalidateSiteConfig(deps)

  return webdavFrom(optionMap(await deps.systemOptions.getMany(ALL_SETTING_KEYS)), requestUrl)
}
