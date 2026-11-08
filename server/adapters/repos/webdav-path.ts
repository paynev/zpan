import { ObjectStatus } from '@shared/constants'
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm'
import { matters } from '../../db/schema'
import type { Database } from '../../platform/interface'
import {
  type CachePolicy,
  type CacheService,
  type Matter,
  WebDavPathError,
  type WebDavPathRepo,
  type WebDavTarget,
  type WebDavWorkspace,
} from '../../usecases/ports'

// Single-user instance: exactly one workspace serves the whole drive. Its
// segment is the first path component under the /dav mount.
const DEFAULT_WORKSPACE: WebDavWorkspace = {
  id: 'default',
  name: 'Drive',
  slug: 'drive',
  pathSegment: 'drive',
}

const WORKSPACES: WebDavWorkspace[] = [DEFAULT_WORKSPACE]

const WEB_DAV_CHILDREN_CACHE_POLICY: CachePolicy<Matter[]> = {
  namespace: 'webdav-children',
  version: 1,
  ttlMs: 5_000,
  maxEntries: 512,
  distributed: false,
  validate(value): value is Matter[] {
    return (
      Array.isArray(value) &&
      value.every(
        (matter) =>
          typeof matter === 'object' &&
          matter !== null &&
          typeof matter.id === 'string' &&
          typeof matter.parent === 'string' &&
          typeof matter.name === 'string',
      )
    )
  },
}

export function createWebDavPathRepo(db: Database, cache?: CacheService): WebDavPathRepo {
  const childrenCacheKey = (parent: string) => JSON.stringify(['default', parent])

  async function cachedChildren(parent: string): Promise<Matter[] | undefined> {
    return (await cache?.get(WEB_DAV_CHILDREN_CACHE_POLICY, childrenCacheKey(parent)))?.value
  }

  async function replaceCachedChildren(parent: string, children: Matter[]): Promise<void> {
    await cache?.replace(WEB_DAV_CHILDREN_CACHE_POLICY, childrenCacheKey(parent), children)
  }

  async function loadChildren(parent: string): Promise<Matter[]> {
    return db
      .select()
      .from(matters)
      .where(
        and(
          eq(matters.parent, parent),
          eq(matters.status, ObjectStatus.ACTIVE),
          isNull(matters.trashedAt),
          isNull(matters.purgedAt),
        ),
      )
      .orderBy(desc(matters.dirtype), asc(matters.name))
  }

  async function listChildren(parent: string): Promise<Matter[]> {
    const children = await cachedChildren(parent)
    if (children) return children
    const loaded = await loadChildren(parent)
    await replaceCachedChildren(parent, loaded)
    return loaded
  }

  async function matterRow(parent: string, name: string): Promise<Matter | null> {
    const rows = await db
      .select()
      .from(matters)
      .where(
        and(
          eq(matters.parent, parent),
          eq(matters.name, name),
          eq(matters.status, ObjectStatus.ACTIVE),
          isNull(matters.trashedAt),
          isNull(matters.purgedAt),
        ),
      )
      .limit(1)
    return rows[0] ?? null
  }

  async function resolveWebDavPath(_userId: string, rawPath: string): Promise<WebDavTarget> {
    const parts = decodeDavPath(rawPath)
    if (parts.length === 0) return { workspace: null, mountRoot: true, parent: '', name: '', matter: null }

    if (!isWorkspaceSegment(parts[0])) throw new WebDavPathError('Workspace not found', 404)

    const matterParts = parts.slice(1)
    if (matterParts.length === 0) {
      return { workspace: DEFAULT_WORKSPACE, mountRoot: false, parent: '', name: '', matter: null }
    }
    const name = matterParts.at(-1) ?? ''
    const parent = matterParts.slice(0, -1).join('/')
    const matter = await matterRow(parent, name)
    return { workspace: DEFAULT_WORKSPACE, mountRoot: false, parent, name, matter }
  }

  return {
    async listUserWorkspaces() {
      return WORKSPACES
    },

    async listChildren(parent) {
      return listChildren(parent)
    },

    resolveWebDavPath,

    async resolveWithChildren(_userId, rawPath) {
      const parts = decodeDavPath(rawPath)
      if (parts.length === 0) {
        return {
          target: { workspace: null, mountRoot: true, parent: '', name: '', matter: null },
          children: [],
        }
      }
      if (!isWorkspaceSegment(parts[0])) throw new WebDavPathError('Workspace not found', 404)

      const matterParts = parts.slice(1)
      if (matterParts.length === 0) {
        return {
          target: { workspace: DEFAULT_WORKSPACE, mountRoot: false, parent: '', name: '', matter: null },
          children: await listChildren(''),
        }
      }

      const name = matterParts.at(-1) ?? ''
      const parent = matterParts.slice(0, -1).join('/')
      const childParent = matterParts.join('/')
      const [cachedSiblings, cachedDirectChildren] = await Promise.all([
        cachedChildren(parent),
        cachedChildren(childParent),
      ])
      const cachedMatter = cachedSiblings?.find((candidate) => candidate.name === name) ?? null
      if (cachedSiblings && cachedDirectChildren) {
        return {
          target: { workspace: DEFAULT_WORKSPACE, mountRoot: false, parent, name, matter: cachedMatter },
          children: cachedDirectChildren,
        }
      }
      if (cachedSiblings) {
        const children = await listChildren(childParent)
        return {
          target: { workspace: DEFAULT_WORKSPACE, mountRoot: false, parent, name, matter: cachedMatter },
          children,
        }
      }

      const rows = await db
        .select()
        .from(matters)
        .where(
          and(
            eq(matters.status, ObjectStatus.ACTIVE),
            isNull(matters.trashedAt),
            isNull(matters.purgedAt),
            or(and(eq(matters.parent, parent), eq(matters.name, name)), eq(matters.parent, childParent)),
          ),
        )
        .orderBy(desc(matters.dirtype), asc(matters.name))

      const matter = rows.find((row) => row.parent === parent && row.name === name) ?? null
      const children = rows.filter((row) => row.parent === childParent && row.id !== matter?.id)
      await replaceCachedChildren(childParent, children)
      return {
        target: { workspace: DEFAULT_WORKSPACE, mountRoot: false, parent, name, matter },
        children,
      }
    },

    async resolveExistingWebDavPath(userId, rawPath) {
      const target = await resolveWebDavPath(userId, rawPath)
      if (!target.matter) throw new WebDavPathError('Not found', 404)
      return target
    },

    async invalidatePaths(_userId, rawPaths) {
      if (!cache || rawPaths.length === 0) return
      const keys = new Set<string>()
      for (const rawPath of rawPaths) {
        const parts = decodeDavPath(rawPath)
        if (parts.length === 0) continue
        const matterParts = parts.slice(1)
        keys.add(childrenCacheKey(matterParts.slice(0, -1).join('/')))
        keys.add(childrenCacheKey(matterParts.join('/')))
        keys.add(childrenCacheKey(''))
      }
      await Promise.all([...keys].map((key) => cache.invalidate(WEB_DAV_CHILDREN_CACHE_POLICY, key)))
    },
  }
}

function isWorkspaceSegment(segment: string): boolean {
  return (
    segment === DEFAULT_WORKSPACE.slug || segment === DEFAULT_WORKSPACE.id || segment === DEFAULT_WORKSPACE.pathSegment
  )
}

function decodeDavPath(rawPath: string): string[] {
  if (!rawPath.startsWith('/')) throw new WebDavPathError('Invalid DAV path', 400)
  if (rawPath.includes('//')) throw new WebDavPathError('Ambiguous DAV path', 400)

  const withoutMount = rawPath.replace(/^\/dav(?:\/|$)/, '/')
  const trimmed = withoutMount.replace(/^\/+|\/+$/g, '')
  if (!trimmed) return []

  return trimmed.split('/').map(decodeSegment)
}

function decodeSegment(segment: string): string {
  if (!segment) throw new WebDavPathError('Ambiguous DAV path', 400)
  if (/%2f|%5c/i.test(segment)) throw new WebDavPathError('Encoded path separators are not allowed', 400)
  if (/%25(?:2e|2f|5c)/i.test(segment)) throw new WebDavPathError('Double-encoded path tricks are not allowed', 400)

  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    throw new WebDavPathError('Invalid path encoding', 400)
  }

  if (!decoded || decoded === '.' || decoded === '..') throw new WebDavPathError('Invalid DAV path segment', 400)
  if (decoded.includes('/') || decoded.includes('\\')) throw new WebDavPathError('Invalid DAV path segment', 400)
  return decoded
}
