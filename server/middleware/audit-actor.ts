import type { RecordAuditEventInput } from '../usecases/ports'
import type { AuthPrincipal } from './platform'

export type AuditActor = Pick<RecordAuditEventInput, 'userId' | 'actorType' | 'actorRef' | 'actorIssuer'>

export function auditActor(principal: AuthPrincipal | null): AuditActor {
  if (!principal) return { userId: null, actorType: 'anonymous', actorRef: null, actorIssuer: null }
  if (principal.kind === 'user') {
    return { userId: principal.userId, actorType: 'user', actorRef: null, actorIssuer: null }
  }
  return { userId: principal.userId, actorType: 'api_key', actorRef: principal.keyId, actorIssuer: null }
}
