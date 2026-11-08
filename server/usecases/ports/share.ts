import type { CreateShareInput } from '@shared/schemas/share'
import type { Matter } from './matter'

// ─── DTOs ──────────────────────────────────────────────────────────────────
// Plain records mirroring the shares / share_recipients tables. Timestamps stay
// Date (the http layer serializes them). Drizzle row types never cross this port.

export interface ShareRecord {
  id: string
  token: string
  kind: string
  matterId: string
  creatorId: string
  passwordHash: string | null
  expiresAt: Date | null
  downloadLimit: number | null
  views: number
  downloads: number
  status: string
  private: boolean
  createdAt: Date
}

export interface ShareRecipientRecord {
  id: string
  shareId: string
  recipientUserId: string | null
  recipientEmail: string | null
  createdAt: Date
}

export interface ShareListItem {
  id: string
  token: string
  kind: string
  matterId: string
  creatorId: string
  expiresAt: Date | null
  downloadLimit: number | null
  views: number
  downloads: number
  status: string
  private: boolean
  createdAt: Date
  matter: { name: string; type: string; dirtype: number }
  recipientCount: number
  creatorName?: string
}

export interface ShareCreatorIdentity {
  name: string
}

export type ShareResolution =
  | { status: 'ok'; share: ShareRecord; matter: Matter; recipients: ShareRecipientRecord[] }
  // matter_trashed carries the records so the creator-only revoke path can still
  // act on the share; viewer-facing callers branch on `status` and ignore them.
  | { status: 'matter_trashed'; share: ShareRecord; matter: Matter; recipients: ShareRecipientRecord[] }
  | { status: 'not_found' }
  | { status: 'revoked' }

// Thrown by createShare on invalid share-shape combinations. Carries a stable
// code the http layer maps to a 400/404.
export class CreateShareError extends Error {
  constructor(public code: 'MATTER_NOT_FOUND' | 'DIRECT_NO_FOLDER' | 'DIRECT_NO_PASSWORD' | 'DIRECT_NO_RECIPIENTS') {
    super(code)
  }
}

export interface ShareRepo {
  create(input: CreateShareInput): Promise<ShareRecord>
  resolveByToken(token: string): Promise<ShareResolution>
  incrementViews(shareId: string): Promise<void>
  hasDownloadsAvailable(shareId: string): Promise<boolean>
  incrementDownloadsAtomic(shareId: string): Promise<{ ok: boolean; downloads: number }>
  decrementDownloads(shareId: string): Promise<void>
  listRecipientUserIds(shareId: string): Promise<string[]>
  revokeByMatter(matterId: string): Promise<void>
  revokeByToken(token: string, creatorId: string): Promise<boolean>
  setPrivacy(token: string, creatorId: string, isPrivate: boolean): Promise<boolean>
  listForApi(
    creatorId: string,
    opts: { pageSize: number; status?: string; after?: { createdAt: Date; id: string } },
  ): Promise<{ items: ShareListItem[]; nextBoundary: { createdAt: Date; id: string } | null }>
  listReceivedForApi(
    userId: string,
    userEmail: string | null,
    opts: { pageSize: number; after?: { createdAt: Date; id: string } },
  ): Promise<{ items: ShareListItem[]; nextBoundary: { createdAt: Date; id: string } | null }>
  // Matter reads supporting the save-to-drive flow. They read the matters table
  // and are co-located in the share repo.
  listDirectActiveChildren(folderPath: string): Promise<Matter[]>
  // Lookups the share routes need; co-located here so the share http layer holds
  // no drizzle.
  getCreatorIdentity(creatorId: string): Promise<ShareCreatorIdentity | null>
  getUserEmail(userId: string): Promise<string | null>
  getMatterName(matterId: string): Promise<string | null>
  findShareChildMatter(
    rootMatter: { id: string; parent: string; name: string },
    childId: string,
  ): Promise<Matter | null>
}
