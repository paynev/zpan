// Plain, framework-free DTOs and the repository port for audit events.
//
// Only the write side is kept: audit events are still recorded by the global
// middleware (uploads, shares, WebDAV, auth), but the admin audit-log reader
// was removed from the single-admin build, so no query methods live here.

import type { ActorAttribution, ActorType } from '@shared/schemas'

export type AuditActorType = ActorType

export interface RecordAuditEventInput {
  userId?: string | null
  actorType?: AuditActorType
  actorRef?: string | null
  actorIssuer?: string | null
  action: string
  targetType: string
  targetId?: string
  targetName: string
  metadata?: Record<string, unknown>
}

export interface AuditRepo {
  record(event: RecordAuditEventInput): Promise<void>
  recordOnce(event: RecordAuditEventInput, idempotencyKey: string, occurredAt?: Date): Promise<void>
}

export interface ActorIdentity {
  type: ActorType
  ref: string | null
  issuer: string | null
}

export interface ActorProfile {
  name: string
  image: string | null
  profileUrl?: string | null
  resolved: boolean
}

export interface ActorDirectory {
  findUserProfiles(userIds: readonly string[]): Promise<ReadonlyMap<string, ActorProfile>>
  findApiKeyNames(keyIds: readonly string[]): Promise<ReadonlyMap<string, string>>
}

export interface AgentInfoGateway {
  // Profiles are display-only and never authoritative. An omitted identity
  // tells the caller to retain the stable issuer/subject fallback.
  resolve(
    actors: readonly ActorIdentity[],
    trustedIssuerOrigins: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, ActorProfile>>
}

export type AuditActorIdentity = ActorIdentity
export type AuditActorProfile = ActorProfile
export type AuditActorDirectory = ActorDirectory
export type { ActorAttribution }

export function actorIdentityKey(actor: ActorIdentity): string {
  return JSON.stringify([actor.type, actor.issuer, actor.ref])
}

export const auditActorIdentityKey = actorIdentityKey
