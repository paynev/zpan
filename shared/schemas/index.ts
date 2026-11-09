import { z } from 'zod'
import { opaqueIdSchema } from './id'

export type { ActorAttribution, ActorIdentity, ActorProfile, ActorType } from './actors'
export { actorAttributionSchema, actorIdentitySchema, actorProfileSchema, actorTypeSchema } from './actors'

export type {
  AnnouncementInput,
  AnnouncementStatus,
  ListAdminAnnouncementsQuery,
  ListAnnouncementsQuery,
} from './announcement'
export {
  announcementInputSchema,
  announcementStatusSchema,
  listAdminAnnouncementsQuerySchema,
  listAnnouncementsQuerySchema,
} from './announcement'
export type { ListAdminAuditQuery } from './audit'
export { listAdminAuditQuerySchema } from './audit'
export type { CanonicalStatus, ErrorInfo, ErrorResponse } from './errors'
export {
  canonicalStatuses,
  canonicalStatusForHttp,
  ERROR_DOMAIN,
  ERROR_INFO_TYPE,
  ErrorReason,
  errorInfoSchema,
  errorResponseSchema,
} from './errors'
export { base62IdSchema, opaqueIdSchema, opaqueTokenSchema, shareTokenSchema } from './id'
export type { ListNotificationsQuery } from './notification'
export { listNotificationsQuerySchema } from './notification'
export type { CursorPage, CursorPageQuery, Page, PageQuery } from './pagination'
export { cursorPageQuerySchema, cursorPageSchema, pageQuerySchema, pageSchema } from './pagination'
export type {
  CreateShareInput,
  CreateShareRequest,
  ShareKind,
  ShareObjectItem,
  ShareObjectsResponse,
  ShareReadmeResponse,
} from './share'
export {
  createShareRequestSchema,
  createShareSchema,
  listSharesQuerySchema,
  shareKindSchema,
  shareObjectItemSchema,
  shareObjectsResponseSchema,
  shareReadmeResponseSchema,
  shareRecipientSchema,
  shareRecipientViewSchema,
} from './share'
export type {
  SiteBranding,
  SiteConfig,
  SiteIdentitySettings,
  SiteSettings,
  SiteWebDavSettings,
  UpdateSiteIdentityInput,
  UpdateSiteWebDavInput,
} from './site-config'
export {
  siteBrandingSchema,
  siteConfigSchema,
  siteIdentitySettingsSchema,
  siteSettingsSchema,
  siteWebDavSettingsSchema,
  updateSiteIdentitySchema,
  updateSiteWebDavSchema,
  webDavVerificationStatusSchema,
} from './site-config'
export type { CreateStorageInput, PatchStorageInput, ReplaceStorageInput } from './storage'
export { createStorageSchema, patchStorageSchema, replaceStorageSchema } from './storage'

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
})

export const conflictStrategySchema = z.enum(['fail', 'rename', 'replace'])
export type ConflictStrategy = z.infer<typeof conflictStrategySchema>

const matterParentPathSchema = z
  .string()
  .describe('Slash-delimited parent folder path relative to the workspace root; use an empty string for the root.')

export const createMatterSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1).optional(),
  size: z.number().int().min(0).optional(),
  parent: matterParentPathSchema.default(''),
  dirtype: z.number().int().default(0),
  onConflict: conflictStrategySchema.optional(),
  storageId: opaqueIdSchema
    .describe(
      'Only site administrators may set this field; omit it to let ZPan automatically select an available storage.',
    )
    .optional(),
})

export type CreateMatterInput = z.infer<typeof createMatterSchema>

export const updateMatterSchema = z.object({
  action: z.literal('update').optional().default('update'),
  name: z.string().min(1).optional(),
  parent: matterParentPathSchema.optional(),
  onConflict: conflictStrategySchema.optional(),
})

export type UpdateMatterInput = z.infer<typeof updateMatterSchema>

export const presignedObjectUploadPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  url: z.string(),
  expiresAt: z.string(),
  headers: z.record(z.string(), z.string()),
  offset: z.number().int().min(0),
  length: z.number().int().min(0),
})

export const objectUploadWorkflowSchema = z.object({
  version: z.literal('1'),
  upload: z.object({
    method: z.literal('PUT'),
    urlField: z.literal('parts[].url'),
    headersField: z.literal('parts[].headers'),
    fileOffsetField: z.literal('parts[].offset'),
    contentLengthField: z.literal('parts[].length'),
    etagHeader: z.literal('ETag'),
  }),
  complete: z.object({
    operationId: z.literal('completeObjectUpload'),
    method: z.literal('POST'),
    path: z.string(),
    partsBodyField: z.literal('parts'),
  }),
  rePresign: z.object({
    operationId: z.literal('presignObjectUploadParts'),
    method: z.literal('POST'),
    path: z.string(),
    partNumbersBodyField: z.literal('partNumbers'),
  }),
  abort: z.object({
    operationId: z.literal('abortObjectUpload'),
    method: z.literal('DELETE'),
    path: z.string(),
  }),
})

// The upload instructions returned by POST /objects for a file draft. File bytes
// still go directly to presigned S3 URLs; the server exposes stable part
// identities so automation never infers part numbers from URL positions.
export const objectUploadInstructionsSchema = z.object({
  sessionId: opaqueIdSchema,
  uploadId: z.string().nullable(),
  mode: z.enum(['single', 'multipart']),
  partSize: z.number().int(),
  partCount: z.number().int().min(1).max(10_000),
  expiresAt: z.string(),
  presignedExpiresAt: z.string(),
  requiredHeaders: z.record(z.string(), z.string()),
  urls: z.array(z.string()),
  parts: z.array(presignedObjectUploadPartSchema),
  workflow: objectUploadWorkflowSchema,
})

export const presignObjectUploadPartsResponseSchema = z.object({
  uploadId: z.string().nullable(),
  mode: z.enum(['single', 'multipart']),
  partSize: z.number().int(),
  partCount: z.number().int().min(1).max(10_000),
  presignedExpiresAt: z.string(),
  requiredHeaders: z.record(z.string(), z.string()),
  parts: z.array(presignedObjectUploadPartSchema),
})

// Re-presign expired part URLs mid-upload (multipart sessions only). The happy
// path uses the URLs returned by POST /objects; this is the fallback.
export const presignObjectUploadPartsSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
})

// POST /api/objects/:id/uploads/:sid/completions — finalize the upload.
// Uniform for every file: one entry for a ≤5 GiB single PutObject, N entries for
// a >5 GiB multipart. Each etag comes from the S3 PUT response header.
export const completeObjectUploadSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().min(1),
      }),
    )
    .min(1),
})

export type PresignObjectUploadPartsInput = z.infer<typeof presignObjectUploadPartsSchema>
export type CompleteObjectUploadInput = z.infer<typeof completeObjectUploadSchema>

// PATCH /api/objects/:id — partial update of a live object (rename / move).
export const patchMatterSchema = z.object({
  name: z.string().min(1).optional(),
  parent: z.string().optional(),
  onConflict: conflictStrategySchema.optional(),
})

export type PatchMatterInput = z.infer<typeof patchMatterSchema>

// POST /api/trash/objects/:id/restorations — move a trashed object back to live.
// onConflict resolves a same-named item created in the original parent while this
// one sat in trash (default 'fail').
export const restoreObjectSchema = z.object({
  onConflict: conflictStrategySchema.optional(),
})

export type RestoreObjectInput = z.infer<typeof restoreObjectSchema>

export const copyMatterSchema = z.object({
  copyFrom: z.string().min(1),
  parent: z.string().default(''),
  onConflict: conflictStrategySchema.optional(),
})

// POST /api/objects/:id/copies — the source object id comes from the path.
export const copyObjectBodySchema = z.object({
  parent: z.string().default(''),
  onConflict: conflictStrategySchema.optional(),
})

export type CopyObjectBodyInput = z.infer<typeof copyObjectBodySchema>
