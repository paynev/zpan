import { describe, expect, it, vi } from 'vitest'
import { type AgentInfoGateway, type AuditEventWithUser, type AuditRepo, auditActorIdentityKey } from '../ports'
import { listAuditEvents } from './audit'

describe('audit usecase', () => {
  it('forwards the query options to listAdminAudit', async () => {
    const result = { items: [], total: 0, page: 1, pageSize: 20 }
    const listAdminAudit = vi.fn(async () => result)
    const resolve = vi.fn(async () => new Map())
    const findApiKeyNames = vi.fn(async () => new Map())
    const findUserProfiles = vi.fn(async () => new Map())
    const out = await listAuditEvents(
      {
        audit: { listAdminAudit } as Pick<AuditRepo, 'listAdminAudit'>,
        auditActorDirectory: { findUserProfiles, findApiKeyNames },
        agentInfo: { resolve } as AgentInfoGateway,
      },
      {
        page: 1,
        pageSize: 20,
      },
    )
    expect(out).toBe(result)
    expect(listAdminAudit).toHaveBeenCalledWith({ page: 1, pageSize: 20 })
    expect(resolve).not.toHaveBeenCalled()
    expect(findApiKeyNames).not.toHaveBeenCalled()
  })

  it('uses the resolved Agent profile without replacing the delegated user [spec: audit/actor-info]', async () => {
    const event = {
      id: 'e1',
      userId: 'u1',
      actorType: 'oauth',
      actorRef: 'agt_1',
      actorIssuer: 'https://id.realmroot.dev/api/auth',
      action: 'upload',
      targetType: 'file',
      targetId: 'f1',
      targetName: 'agent.txt',
      metadata: null,
      createdAt: new Date(0),
      user: { id: 'u1', name: 'Ambor', image: null },
      actor: { name: 'Agent · agt_1', image: null, resolved: false },
    } satisfies AuditEventWithUser
    const identity = { type: 'oauth', ref: 'agt_1', issuer: 'https://id.realmroot.dev/api/auth' } as const
    const resolved = { name: 'Mac Agent', image: 'https://id.realmroot.dev/agent.svg', resolved: true }
    const resolve = vi.fn(async () => new Map([[auditActorIdentityKey(identity), resolved]]))

    const out = await listAuditEvents(
      {
        audit: { listAdminAudit: async () => ({ items: [event], total: 1, page: 1, pageSize: 20 }) },
        auditActorDirectory: {
          findUserProfiles: async () => new Map(),
          findApiKeyNames: async () => new Map(),
        },
        agentInfo: { resolve },
      },
      { page: 1, pageSize: 20 },
    )

    expect(out.items[0]).toMatchObject({ user: { name: 'Ambor' }, actor: resolved })
    expect(resolve).toHaveBeenCalledWith([identity], new Set())
  })

  it('formats the API key name as the actor without calling Agent Info [spec: audit/actor-info]', async () => {
    const event = {
      id: 'e2',
      userId: 'u1',
      actorType: 'api_key',
      actorRef: 'key-1',
      actorIssuer: null,
      action: 'share_created',
      targetType: 'share',
      targetId: 'share-1',
      targetName: 'share-1',
      metadata: null,
      createdAt: new Date(0),
      user: { id: 'u1', name: 'Ambor', image: null },
      actor: { name: 'API key · key-1', image: null, resolved: false },
    } satisfies AuditEventWithUser
    const resolve = vi.fn(async () => new Map())

    const out = await listAuditEvents(
      {
        audit: { listAdminAudit: async () => ({ items: [event], total: 1, page: 1, pageSize: 20 }) },
        auditActorDirectory: {
          findUserProfiles: async () => new Map(),
          findApiKeyNames: async () => new Map([['key-1', 'WebDAV key']]),
        },
        agentInfo: { resolve },
      },
      { page: 1, pageSize: 20 },
    )

    expect(out.items[0]).toMatchObject({
      user: { name: 'Ambor' },
      actor: { name: 'API key · WebDAV key', image: null, resolved: true },
    })
    expect(resolve).not.toHaveBeenCalled()
  })
})
