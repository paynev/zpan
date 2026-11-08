import { OpenAPIHono, z } from '@hono/zod-openapi'
import { AuthorizationScope } from '@shared/authorization'
import { opaqueIdSchema, pageQuerySchema, pageSchema } from '@shared/schemas'
import type { Env } from '../../middleware/platform'
import type { AuditEventWithUser } from '../../usecases/ports'
import { badRequest } from '../../usecases/ports'
import { listAuditEvents } from '../../usecases/site/audit'
import { authRoute, errorResponse, jsonContent } from '../openapi'

const auditEventSchema = z
  .object({
    id: opaqueIdSchema,
    userId: opaqueIdSchema.nullable(),
    actorType: z.enum(['user', 'api_key', 'oauth', 'agent', 'anonymous', 'system', 'device', 'task-upload']),
    actorRef: z.string().nullable(),
    actorIssuer: z.string().nullable(),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string().nullable(),
    targetName: z.string(),
    metadata: z.string().nullable(),
    createdAt: z.string(),
    user: z.object({ id: opaqueIdSchema.nullable(), name: z.string(), image: z.string().nullable() }),
    actor: z.object({ name: z.string(), image: z.string().nullable(), resolved: z.boolean() }),
  })
  .openapi('AuditEvent')

type AuditEventDTO = z.infer<typeof auditEventSchema>

function toAuditEventDTO(e: AuditEventWithUser): AuditEventDTO {
  return { ...e, createdAt: e.createdAt.toISOString() }
}

const auditPageSchema = pageSchema(auditEventSchema, 'AuditEventPage')

const listAuditQuerySchema = pageQuerySchema.extend({
  userId: opaqueIdSchema.optional(),
  action: z.string().optional(),
  targetType: z.string().optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
})

const listRoute = authRoute(
  { scopes: [AuthorizationScope.AUDIT_EVENTS_READ], siteRole: 'admin' },
  {
    operationId: 'listAuditEvents',
    summary: 'List audit events',
    tags: ['Audit'],
    method: 'get',
    path: '/',
    request: { query: listAuditQuerySchema },
    responses: { 200: jsonContent(auditPageSchema, 'Audit events'), 400: errorResponse('Invalid query') },
  },
)

export const adminAudit = new OpenAPIHono<Env>().openapi(listRoute, async (c) => {
  const { page, pageSize, userId, action, targetType, createdFrom, createdTo } = c.req.valid('query')
  const createdFromDate = createdFrom ? new Date(createdFrom) : undefined
  const createdToDate = createdTo ? new Date(createdTo) : undefined
  if (createdFromDate && createdToDate && createdFromDate > createdToDate) {
    throw badRequest('createdFrom must be before createdTo', 'INVALID_TIME_RANGE')
  }

  const result = await listAuditEvents(c.get('deps'), {
    page,
    pageSize,
    userId,
    action,
    targetType,
    createdFrom: createdFromDate,
    createdTo: createdToDate,
  })
  return c.json({ ...result, items: result.items.map(toAuditEventDTO) }, 200)
})
