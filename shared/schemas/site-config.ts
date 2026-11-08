import { z } from 'zod'

export const brandingThemePresetSchema = z.enum(['default', 'ocean', 'forest', 'rose']).openapi('BrandingThemePreset')

export const brandingThemeValuesSchema = z
  .object({
    primaryColor: z.string(),
    primaryForeground: z.string(),
    canvasColor: z.string(),
    sidebarAccentColor: z.string(),
    ringColor: z.string(),
  })
  .openapi('BrandingThemeValues')

export const siteBrandingSchema = z
  .object({
    logoUrl: z.string().nullable(),
    faviconUrl: z.string().nullable(),
    wordmark: z.string().nullable(),
    hidePoweredBy: z.boolean(),
    theme: z.object({
      mode: z.enum(['preset', 'custom']),
      preset: brandingThemePresetSchema,
      custom: brandingThemeValuesSchema.nullable(),
      configured: z.boolean(),
    }),
  })
  .openapi('SiteBranding')

export const siteConfigSchema = z
  .object({
    site: z.object({ name: z.string(), description: z.string(), publicUrl: z.string() }),
    branding: siteBrandingSchema,
    services: z.object({
      webdav: z.object({ enabled: z.boolean(), url: z.string() }),
    }),
  })
  .openapi('SiteConfig')

const publicOriginSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    )
  }, 'Public URL must be an HTTP or HTTPS origin without a path, query, or fragment')
  .openapi('PublicOrigin')

export const siteIdentitySettingsSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    publicUrl: publicOriginSchema,
  })
  .openapi('SiteIdentitySettings')

export const webDavVerificationStatusSchema = z
  .enum(['disabled', 'unverified', 'ready', 'failed'])
  .openapi('WebDavVerificationStatus')

export const siteWebDavSettingsSchema = z
  .object({
    enabled: z.boolean(),
    domain: z.string(),
    pathUrl: z.url(),
    candidateUrl: z.url().nullable(),
    status: webDavVerificationStatusSchema,
    lastVerifiedAt: z.iso.datetime().nullable(),
    error: z.string().nullable(),
  })
  .openapi('SiteWebDavSettings')

export const siteSettingsSchema = z
  .object({
    identity: siteIdentitySettingsSchema,
    webdav: siteWebDavSettingsSchema,
  })
  .openapi('SiteSettings')

export const updateSiteIdentitySchema = siteIdentitySettingsSchema
export const updateSiteWebDavSchema = z
  .object({
    enabled: z.boolean(),
    domain: z
      .string()
      .trim()
      .refine(
        (value) =>
          value === '' ||
          (value.length <= 253 &&
            /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(value)),
        'WebDAV domain must be a hostname without a protocol, port, or path',
      ),
  })
  .openapi('UpdateSiteWebDav')

export type SiteConfig = z.infer<typeof siteConfigSchema>
export type SiteBranding = z.infer<typeof siteBrandingSchema>
export type SiteSettings = z.infer<typeof siteSettingsSchema>
export type SiteIdentitySettings = z.infer<typeof siteIdentitySettingsSchema>
export type SiteWebDavSettings = z.infer<typeof siteWebDavSettingsSchema>
export type UpdateSiteIdentityInput = z.infer<typeof updateSiteIdentitySchema>
export type UpdateSiteWebDavInput = z.infer<typeof updateSiteWebDavSchema>
