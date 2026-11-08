import { SITE_PUBLIC_ORIGIN_KEY } from '../../domain/site-public-origin'

export const SITE_SETTING_KEYS = {
  name: 'site_name',
  description: 'site_description',
  publicOrigin: SITE_PUBLIC_ORIGIN_KEY,
  webdavVerifiedOrigin: 'webdav_verified_origin',
  webdavVerifiedAt: 'webdav_verified_at',
  webdavVerificationError: 'webdav_verification_error',
  webdavEnabled: 'webdav_enabled',
  webdavDomain: 'webdav_domain',
} as const
