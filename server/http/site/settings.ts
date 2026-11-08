import { OpenAPIHono } from '@hono/zod-openapi'
import { AuthorizationScope } from '@shared/authorization'
import {
  siteIdentitySettingsSchema,
  siteSettingsSchema,
  siteWebDavSettingsSchema,
  updateSiteIdentitySchema,
  updateSiteWebDavSchema,
} from '@shared/schemas'
import type { Env } from '../../middleware/platform'
import { getSiteSettings, updateSiteIdentity, updateSiteWebDav, verifySiteWebDav } from '../../usecases/site/settings'
import { authRoute, errorResponse, jsonBody, jsonContent } from '../openapi'

const getRoute = authRoute(
  { scopes: [AuthorizationScope.SITE_SETTINGS_READ], siteRole: 'admin' },
  {
    operationId: 'getSiteSettings',
    summary: 'Get editable site settings',
    tags: ['Site Settings'],
    method: 'get',
    path: '/',
    responses: { 200: jsonContent(siteSettingsSchema, 'Editable site settings') },
  },
)

const updateIdentityRoute = authRoute(
  { scopes: [AuthorizationScope.SITE_SETTINGS_UPDATE], siteRole: 'admin' },
  {
    operationId: 'updateSiteIdentity',
    summary: 'Update site identity settings',
    tags: ['Site Settings'],
    method: 'put',
    path: '/identity',
    request: jsonBody(updateSiteIdentitySchema),
    responses: {
      200: jsonContent(siteIdentitySettingsSchema, 'Updated site identity settings'),
      400: errorResponse('Invalid site identity'),
    },
  },
)

const verifyWebDavRoute = authRoute(
  { scopes: [AuthorizationScope.SITE_SETTINGS_UPDATE], siteRole: 'admin' },
  {
    operationId: 'verifySiteWebDav',
    summary: 'Verify the configured or derived WebDAV domain',
    tags: ['Site Settings'],
    method: 'post',
    path: '/webdav/verifications',
    responses: { 200: jsonContent(siteWebDavSettingsSchema, 'Current WebDAV verification status') },
  },
)

const updateWebDavRoute = authRoute(
  { scopes: [AuthorizationScope.SITE_SETTINGS_UPDATE], siteRole: 'admin' },
  {
    operationId: 'updateSiteWebDav',
    summary: 'Update WebDAV settings',
    tags: ['Site Settings'],
    method: 'put',
    path: '/webdav',
    request: jsonBody(updateSiteWebDavSchema),
    responses: {
      200: jsonContent(siteWebDavSettingsSchema, 'Updated WebDAV settings'),
      400: errorResponse('Invalid WebDAV settings'),
    },
  },
)

export const siteSettings = new OpenAPIHono<Env>()
  .openapi(getRoute, async (c) => c.json(await getSiteSettings(c.get('deps'), c.req.url), 200))
  .openapi(updateIdentityRoute, async (c) => c.json(await updateSiteIdentity(c.get('deps'), c.req.valid('json')), 200))
  .openapi(updateWebDavRoute, async (c) =>
    c.json(await updateSiteWebDav(c.get('deps'), c.req.valid('json'), c.req.url), 200),
  )
  .openapi(verifyWebDavRoute, async (c) => c.json(await verifySiteWebDav(c.get('deps'), c.req.url, fetch), 200))
