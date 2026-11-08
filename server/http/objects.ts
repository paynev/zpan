import { OpenAPIHono, z } from '@hono/zod-openapi'
import { AuthorizationScope } from '@shared/authorization'
import {
  actorIdentitySchema,
  actorProfileSchema,
  completeObjectUploadSchema,
  copyObjectBodySchema,
  createMatterSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  objectUploadInstructionsSchema,
  opaqueIdSchema,
  patchMatterSchema,
  presignObjectUploadPartsResponseSchema,
  presignObjectUploadPartsSchema,
} from '@shared/schemas'
import type { Context } from 'hono'
import { transferAuditActor } from '../middleware/audit-transfers'
import type { Env } from '../middleware/platform'
import {
  abortUpload,
  completeUpload,
  copyObject,
  createObject,
  getObject,
  getObjectCreator,
  listObjects,
  matterCreatorIdentity,
  type ObjectActor,
  ObjectUploadSessionError,
  presignUploadSessionParts,
  trashObject,
  updateObject,
} from '../usecases/object'
import { forbidden, type Matter, type MatterListItem, unauthorized } from '../usecases/ports'
import { createTrafficEventId, recordDownloadIssued } from '../usecases/transfer-activity'
import { authRoute, errorResponse, jsonBody, jsonContent } from './openapi'
import { decodeOptionalPageToken, directoryCursorCodec, encodeNextPageToken, pageQueryFingerprint } from './page-token'

// The wire shape of a file/folder — exactly what the API serializes. Timestamps
// are strings here (the domain `Matter` carries them as `Date`); `toMatterDTO`
// below bridges the two, so this schema is provably what handlers return. Doc-only
// for the frontend (callers go through `unwrap<T>()`), but the single source the
// OpenAPI document and SDKs derive the `Matter` model from.
const matterSchema = z
  .object({
    id: opaqueIdSchema,
    alias: z.string(),
    name: z.string(),
    type: z.string(),
    size: z.number().int().nullable(),
    dirtype: z.number().int().nullable(),
    parent: z
      .string()
      .describe('Slash-delimited parent folder path relative to the workspace root; empty for root objects.'),
    object: z.string(),
    storageId: opaqueIdSchema,
    status: z.string(),
    trashedAt: z.number().int().nullable(),
    createdBy: actorIdentitySchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Matter')

type MatterDTO = z.infer<typeof matterSchema>

// The one place the domain `Matter` crosses to the wire: serialize `Date`
// timestamps to ISO strings, pass everything else through. Its return type is the
// schema's inferred type, so a drift between `Matter` and `matterSchema` is a
// compile error — not a silent lie in the document.
function toMatterDTO(m: Matter, createdBy: MatterDTO['createdBy']): MatterDTO {
  return {
    id: m.id,
    alias: m.alias,
    name: m.name,
    type: m.type,
    size: m.size,
    dirtype: m.dirtype,
    parent: m.parent,
    object: m.object,
    storageId: m.storageId,
    status: m.status,
    trashedAt: m.trashedAt,
    createdBy,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }
}

const objectListItemSchema = matterSchema
  .extend({ hasChildren: z.boolean().describe('Whether this folder contains at least one child folder.') })
  .openapi('ObjectListItem')
type ObjectListItemDTO = z.infer<typeof objectListItemSchema>

function toObjectListItemDTO(item: MatterListItem, createdBy: MatterDTO['createdBy']): ObjectListItemDTO {
  return { ...toMatterDTO(item, createdBy), hasChildren: item.hasChildren }
}

function matterDTO(matter: Matter): MatterDTO {
  return toMatterDTO(matter, matterCreatorIdentity(matter))
}

const objectPageSchema = cursorPageSchema(objectListItemSchema, 'ObjectPage')

// POST / returns the created object plus, for a file draft, the upload
// instructions: the server-decided part size and the presigned URLs to PUT each
// slice to (1 URL = single PutObject, N URLs = multipart).
const objectCreateResultSchema = matterSchema.extend({ upload: objectUploadInstructionsSchema.optional() })

// GET /{id} returns the object plus a presigned download URL for files.
const objectWithDownloadSchema = matterSchema.extend({ downloadUrl: z.string().optional() })

// List endpoint reads query params ad-hoc; declared here for docs + RPC typing.
// The non-pagination filters are optional so callers may send any subset; `page`
// comes from the shared integer-coerced pagination schema. The file manager loads a
// whole folder client-side (no UI paging, FILES_PAGE_SIZE=500), so this list
// overrides the shared pageSize cap of 100 with a higher ceiling — the rest of the
// API keeps the 100 default. Live objects only — the recycle bin is GET /trash/objects.
const listObjectsQuerySchema = cursorPageQuerySchema.extend({
  parent: z
    .string()
    .describe('Slash-delimited parent folder path relative to the workspace root; empty for the root.')
    .optional(),
  path: z
    .string()
    .describe('Alias for parent: the slash-delimited parent folder path relative to the workspace root.')
    .optional(),
  type: z.string().optional(),
  search: z.string().optional(),
})

const idParam = z.object({ id: opaqueIdSchema })
const sessionParams = z.object({ id: opaqueIdSchema, uploadSessionId: opaqueIdSchema })
const abortUploadQuerySchema = z.object({
  strictStorageCleanup: z.enum(['1', 'true']).optional(),
})

// The caller acting on objects: the authenticated user. The actor identity is the
// authorization context's actor (session user or API key), falling back to the
// raw user id.
function objectActor(c: Context<Env>): ObjectActor {
  const actor = c.get('authzContext').actor
  if (!actor) throw unauthorized()
  return {
    kind: 'user',
    userId: c.get('userId') as string,
    identity: { type: actor.type, ref: actor.ref, issuer: null },
  }
}

// The id recorded in matter/activity logs.
function actorId(c: Context<Env>): string {
  return c.get('userId') ?? 'system'
}

const listRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_READ] },
  {
    operationId: 'listObjects',
    summary: 'List objects',
    tags: ['Objects'],
    method: 'get',
    path: '/',
    request: { query: listObjectsQuerySchema },
    responses: {
      200: jsonContent(objectPageSchema, 'Objects'),
      403: errorResponse('Forbidden'),
    },
  },
)

const createObjectRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_CREATE] },
  {
    operationId: 'createObject',
    summary: 'Create object',
    description:
      'For a file, creates a draft and returns a self-contained direct-upload workflow. PUT each local file slice identified by upload.parts[].offset and upload.parts[].length to its presigned URL with the supplied headers, record each response ETag, then call upload.workflow.complete.operationId with every {partNumber, etag}. File bytes go directly to storage and never pass through ZPan. Use the advertised re-presign action for expired URLs and abort action to discard an unfinished draft.',
    tags: ['Objects'],
    method: 'post',
    path: '/',
    request: jsonBody(createMatterSchema, {
      name: 'notes.txt',
      type: 'text/plain',
      size: 12,
      parent: '',
      dirtype: 0,
      onConflict: 'fail',
    }),
    responses: {
      201: jsonContent(objectCreateResultSchema, 'Created object (folder, or file draft with upload instructions)'),
      400: errorResponse('File too large'),
      403: errorResponse('Forbidden'),
      409: errorResponse('Name conflict'),
      503: errorResponse('No storage configured'),
    },
  },
)

const presignPartsRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_CREATE] },
  {
    operationId: 'presignObjectUploadParts',
    summary: 'Re-presign upload parts',
    description:
      'Returns replacement presigned PUT descriptors for the requested part numbers. Each descriptor includes the exact local file offset and length. Upload those slices, capture each response ETag, and finish through completeObjectUpload.',
    tags: ['Objects'],
    method: 'post',
    path: '/{id}/uploads/{uploadSessionId}/parts',
    request: { params: sessionParams, ...jsonBody(presignObjectUploadPartsSchema) },
    responses: {
      200: jsonContent(presignObjectUploadPartsResponseSchema, 'Presigned upload parts'),
      400: errorResponse('Invalid upload session'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      502: errorResponse('Storage failure'),
    },
  },
)

const completionsRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_CREATE] },
  {
    operationId: 'completeObjectUpload',
    summary: 'Complete upload',
    description:
      'Finalizes a direct upload after every advertised part has been PUT to storage. Send one {partNumber, etag} entry per part, using the ETag response header returned by storage.',
    tags: ['Objects'],
    method: 'post',
    path: '/{id}/uploads/{uploadSessionId}/completions',
    request: { params: sessionParams, ...jsonBody(completeObjectUploadSchema) },
    responses: {
      200: jsonContent(matterSchema, 'Finalized live object'),
      400: errorResponse('Invalid upload session'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      502: errorResponse('Storage failure'),
    },
  },
)

const abortUploadRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_CREATE] },
  {
    operationId: 'abortObjectUpload',
    summary: 'Abort upload',
    tags: ['Objects'],
    method: 'delete',
    path: '/{id}/uploads/{uploadSessionId}',
    request: { params: sessionParams, query: abortUploadQuerySchema },
    responses: {
      204: { description: 'Aborted upload and discarded the draft' },
      400: errorResponse('Invalid upload session'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      502: errorResponse('Storage cleanup failed'),
    },
  },
)

const getObjectRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_READ] },
  {
    operationId: 'getObject',
    summary: 'Get object',
    tags: ['Objects'],
    method: 'get',
    path: '/{id}',
    request: { params: idParam },
    responses: {
      200: jsonContent(objectWithDownloadSchema, 'Object'),
      404: errorResponse('Not found'),
    },
  },
)

const getObjectCreatorRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_READ] },
  {
    operationId: 'getObjectCreator',
    summary: 'Get object creator',
    tags: ['Objects'],
    method: 'get',
    path: '/{id}/creator',
    request: { params: idParam },
    responses: {
      200: jsonContent(actorProfileSchema, 'Object creator profile'),
      404: errorResponse('Not found'),
    },
  },
)

const patchObjectRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_UPDATE] },
  {
    operationId: 'updateObject',
    summary: 'Update object',
    tags: ['Objects'],
    method: 'patch',
    path: '/{id}',
    request: { params: idParam, ...jsonBody(patchMatterSchema) },
    responses: {
      200: jsonContent(matterSchema, 'Updated object'),
      400: errorResponse('Bad request'),
      404: errorResponse('Not found'),
    },
  },
)

const deleteObjectRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_DELETE] },
  {
    operationId: 'deleteObject',
    summary: 'Delete object',
    tags: ['Objects'],
    method: 'delete',
    path: '/{id}',
    request: { params: idParam },
    responses: {
      // Soft delete: the object moves to trash (GET /trash/objects). Permanent
      // removal is DELETE /trash/objects/{id}.
      204: { description: 'Object moved to trash' },
      404: errorResponse('Not found'),
    },
  },
)

const copyObjectRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_UPDATE] },
  {
    operationId: 'copyObject',
    summary: 'Copy object',
    tags: ['Objects'],
    method: 'post',
    path: '/{id}/copies',
    request: { params: idParam, ...jsonBody(copyObjectBodySchema) },
    responses: {
      201: jsonContent(matterSchema, 'Copied object'),
      404: errorResponse('Not found'),
    },
  },
)

const app = new OpenAPIHono<Env>()

const objects = app
  .openapi(listRoute, async (c) => {
    const query = c.req.valid('query')
    const fingerprint = await pageQueryFingerprint({
      parent: query.path ?? query.parent ?? '',
      type: query.type ?? null,
      search: query.search ?? null,
      pageSize: query.pageSize,
    })
    const after = await decodeOptionalPageToken(c.get('platform'), query.pageToken, {
      query: fingerprint,
      codec: directoryCursorCodec,
    })
    const result = await listObjects(c.get('deps'), {
      filters: {
        parent: query.path ?? query.parent ?? '',
        typeFilter: query.type,
        search: query.search,
        pageSize: query.pageSize,
        after,
      },
    })
    if (!result.ok) throw result.error
    return c.json(
      {
        items: result.result.items.map((item) => toObjectListItemDTO(item, matterCreatorIdentity(item))),
        nextPageToken: await encodeNextPageToken(c.get('platform'), result.result.nextBoundary, {
          query: fingerprint,
          codec: directoryCursorCodec,
        }),
      },
      200,
    )
  })
  .openapi(getObjectCreatorRoute, async (c) => {
    const result = await getObjectCreator(c.get('deps'), {
      objectId: c.req.valid('param').id,
    })
    if (!result.ok) throw result.error
    return c.json(result.creator, 200)
  })
  .openapi(createObjectRoute, async (c) => {
    const input = c.req.valid('json')
    if (input.storageId && c.get('userRole') !== 'admin') throw forbidden('Forbidden')

    const result = await createObject(c.get('deps'), { actor: objectActor(c), input })
    if (!result.ok) throw result.error
    const matter = matterDTO(result.matter)
    if ('upload' in result) return c.json({ ...matter, upload: result.upload }, 201)
    return c.json(matter, 201)
  })
  .openapi(presignPartsRoute, async (c) => {
    const objectId = c.req.valid('param').id
    const uploadSessionId = c.req.valid('param').uploadSessionId
    const result = await presignUploadSessionParts(c.get('deps'), {
      objectId,
      sessionId: uploadSessionId,
      partNumbers: c.req.valid('json').partNumbers,
    })
    return c.json(result, 200)
  })
  // Finalize the upload (draft → live). The client has PUT every slice and read
  // its ETag; the server HEADs (single PutObject) or CompleteMultipartUpload,
  // then activates the draft. NameConflictError thrown by the activation
  // propagates to onError (409).
  .openapi(completionsRoute, async (c) => {
    const objectId = c.req.valid('param').id
    const uploadSessionId = c.req.valid('param').uploadSessionId

    const result = await completeUpload(c.get('deps'), {
      objectId,
      sessionId: uploadSessionId,
      parts: c.req.valid('json').parts,
      actorId: actorId(c),
    })
    if (!result.ok) {
      if ('error' in result) throw result.error
      throw new ObjectUploadSessionError('not_found') // draft gone
    }
    return c.json(matterDTO(result.matter), 200)
  })
  .openapi(abortUploadRoute, async (c) => {
    const objectId = c.req.valid('param').id
    const uploadSessionId = c.req.valid('param').uploadSessionId
    await abortUpload(c.get('deps'), {
      objectId,
      sessionId: uploadSessionId,
      actorId: actorId(c),
      strictStorageCleanup: c.req.valid('query').strictStorageCleanup !== undefined,
    })
    return c.body(null, 204)
  })
  .openapi(getObjectRoute, async (c) => {
    const result = await getObject(c.get('deps'), {
      objectId: c.req.valid('param').id,
    })
    if (result.ok) {
      if ('downloadUrl' in result) {
        await recordDownloadIssued(
          c.get('deps'),
          transferAuditActor(c.get('principal')),
          'object_download',
          {
            targetType: 'file',
            targetId: result.matter.id,
            targetName: result.matter.name,
            bytes: result.matter.size ?? 0,
            source: 'object_download',
            metadata: { matterId: result.matter.id, storageId: result.matter.storageId },
          },
          createTrafficEventId(),
        )
        return c.json({ ...matterDTO(result.matter), downloadUrl: result.downloadUrl }, 200)
      }
      return c.json(matterDTO(result.matter), 200)
    }
    throw result.error
  })
  .openapi(patchObjectRoute, async (c) => {
    const result = await updateObject(c.get('deps'), {
      objectId: c.req.valid('param').id,
      input: c.req.valid('json'),
    })
    if (!result.ok) throw result.error
    return c.json(matterDTO(result.matter), 200)
  })
  // Soft delete: move a live object to trash. Permanent removal is
  // DELETE /trash/objects/{id}; discarding a draft is DELETE /{id}/uploads/{sid}.
  .openapi(deleteObjectRoute, async (c) => {
    const result = await trashObject(c.get('deps'), {
      objectId: c.req.valid('param').id,
    })
    if (!result.ok) throw result.error
    return c.body(null, 204)
  })
  .openapi(copyObjectRoute, async (c) => {
    const body = c.req.valid('json')
    const result = await copyObject(c.get('deps'), {
      userId: c.get('userId')!,
      actor: objectActor(c),
      input: { copyFrom: c.req.valid('param').id, parent: body.parent, onConflict: body.onConflict },
    })
    if (!result.ok) throw result.error
    return c.json(matterDTO(result.matter), 201)
  })

export default objects
