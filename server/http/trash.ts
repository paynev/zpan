import { OpenAPIHono, z } from '@hono/zod-openapi'
import { AuthorizationScope } from '@shared/authorization'
import { cursorPageQuerySchema, cursorPageSchema, opaqueIdSchema, restoreObjectSchema } from '@shared/schemas'
import type { Env } from '../middleware/platform'
import { deleteObject, getTrashObject, listTrashedObjects, restoreObject } from '../usecases/object'
import { type Matter, notFound } from '../usecases/ports'
import { authRoute, errorResponse, jsonBody, jsonContent } from './openapi'
import { decodeOptionalPageToken, encodeNextPageToken, pageQueryFingerprint, trashCursorCodec } from './page-token'

// The trashed-object wire shape mirrors the live Matter model; trash is a
// grouping/view of `objects`, not a separate resource.
const matterSchema = z
  .object({
    id: opaqueIdSchema,
    alias: z.string(),
    name: z.string(),
    type: z.string(),
    size: z.number().int().nullable(),
    dirtype: z.number().int().nullable(),
    parent: z.string(),
    object: z.string(),
    storageId: opaqueIdSchema,
    status: z.string(),
    trashedAt: z.number().int().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('TrashObject')

type MatterDTO = z.infer<typeof matterSchema>

function toMatterDTO(m: Matter): MatterDTO {
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
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  }
}

const trashPageSchema = cursorPageSchema(matterSchema, 'TrashObjectPage')
const idParam = z.object({ id: opaqueIdSchema })

const listTrashRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_READ] },
  {
    operationId: 'listTrashObjects',
    summary: 'List trashed objects',
    tags: ['Trash'],
    method: 'get',
    path: '/objects',
    request: { query: cursorPageQuerySchema },
    responses: {
      200: jsonContent(trashPageSchema, 'Trashed objects (roots only)'),
    },
  },
)

const getTrashObjectRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_READ] },
  {
    operationId: 'getTrashObject',
    summary: 'Get trashed object',
    tags: ['Trash'],
    method: 'get',
    path: '/objects/{id}',
    request: { params: idParam },
    responses: {
      200: jsonContent(matterSchema, 'Trashed object'),
      404: errorResponse('Not found'),
    },
  },
)

const restoreObjectRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_UPDATE] },
  {
    operationId: 'restoreObject',
    summary: 'Restore trashed object',
    tags: ['Trash'],
    method: 'post',
    path: '/objects/{id}/restorations',
    request: { params: idParam, ...jsonBody(restoreObjectSchema) },
    responses: {
      200: jsonContent(matterSchema, 'Restored object'),
      404: errorResponse('Not found'),
      409: errorResponse('Name conflict'),
    },
  },
)

const purgeObjectRoute = authRoute(
  { scopes: [AuthorizationScope.OBJECTS_PURGE] },
  {
    operationId: 'purgeTrashObject',
    summary: 'Permanently delete trashed object',
    tags: ['Trash'],
    method: 'delete',
    path: '/objects/{id}',
    request: { params: idParam },
    responses: {
      204: { description: 'Permanently removed (recursive subtree purge)' },
      404: errorResponse('Not found'),
    },
  },
)

const app = new OpenAPIHono<Env>()

const trash = app
  .openapi(listTrashRoute, async (c) => {
    const query = c.req.valid('query')
    const fingerprint = await pageQueryFingerprint({ pageSize: query.pageSize })
    const after = await decodeOptionalPageToken(c.get('platform'), query.pageToken, {
      query: fingerprint,
      codec: trashCursorCodec,
    })
    const result = await listTrashedObjects(c.get('deps'), { pageSize: query.pageSize, after })
    return c.json(
      {
        items: result.result.items.map(toMatterDTO),
        nextPageToken: await encodeNextPageToken(c.get('platform'), result.result.nextBoundary, {
          query: fingerprint,
          codec: trashCursorCodec,
        }),
      },
      200,
    )
  })
  .openapi(getTrashObjectRoute, async (c) => {
    const result = await getTrashObject(c.get('deps'), { objectId: c.req.valid('param').id })
    if (!result.ok) throw result.error
    return c.json(toMatterDTO(result.matter), 200)
  })
  .openapi(restoreObjectRoute, async (c) => {
    // NameConflictError from the restore (a same-named item appeared while
    // trashed) propagates to onError → 409.
    const result = await restoreObject(c.get('deps'), {
      objectId: c.req.valid('param').id,
      onConflict: c.req.valid('json').onConflict,
    })
    if (!result.ok) throw result.error
    return c.json(toMatterDTO(result.matter), 200)
  })
  .openapi(purgeObjectRoute, async (c) => {
    const result = await deleteObject(c.get('deps'), {
      objectId: c.req.valid('param').id,
    })
    if (!result.ok) throw notFound()
    return c.body(null, 204)
  })

export default trash
