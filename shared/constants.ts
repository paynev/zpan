// Cold-start deadline for the Worker app initialization. Keep this outside the
// Worker entry module: workerd treats every named export of the entry as a
// handler/Durable Object binding and rejects non-function values at startup.
export const APP_INITIALIZATION_TIMEOUT_MS = 10_000

export const UserRole = {
  ADMIN: 'admin',
  MEMBER: 'member',
} as const

export type UserRole = (typeof UserRole)[keyof typeof UserRole]

export const DirType = {
  FILE: 0,
  USER_FOLDER: 1,
  SYSTEM_FOLDER: 2,
} as const

export type DirType = (typeof DirType)[keyof typeof DirType]

export const StorageStatus = {
  UNKNOWN: 'unknown',
  HEALTHY: 'healthy',
  UNHEALTHY: 'unhealthy',
} as const

export type StorageStatus = (typeof StorageStatus)[keyof typeof StorageStatus]

export const StorageStatusReason = {
  CORS: 'cors',
  AUTHENTICATION_FAILED: 'authentication_failed',
  PERMISSION_DENIED: 'permission_denied',
  BUCKET_NOT_FOUND: 'bucket_not_found',
  NETWORK_ERROR: 'network_error',
  UNKNOWN: 'unknown',
} as const

export type StorageStatusReason = (typeof StorageStatusReason)[keyof typeof StorageStatusReason]

// Soft delete is tracked by the `trashedAt` timestamp, not a status value:
// live = active & trashedAt IS NULL, trash = active & trashedAt IS NOT NULL.
export const ObjectStatus = {
  DRAFT: 'draft',
  ACTIVE: 'active',
} as const

export type ObjectStatus = (typeof ObjectStatus)[keyof typeof ObjectStatus]

export const ZPAN_GITHUB_URL = 'https://github.com/saltbo/zpan'
// The About page renders this hand-maintained, product-facing changelog in a
// side drawer; raw.githubusercontent.com serves the file with CORS.
export const ZPAN_CHANGELOG_RAW_URL = 'https://raw.githubusercontent.com/saltbo/zpan/main/CHANGELOG.md'
// The latest-version indicator comes from the newest published GitHub Release
// (tag_name), not the changelog file — releases are the source of truth for
// "what's the latest shipped version".
export const ZPAN_RELEASES_LATEST_API_URL = 'https://api.github.com/repos/saltbo/zpan/releases/latest'
// Build a link to a specific commit on GitHub.
export const githubCommitUrl = (sha: string) => `${ZPAN_GITHUB_URL}/commit/${sha}`
export const DEFAULT_SITE_NAME = 'ZPan'
export const DEFAULT_SITE_DESCRIPTION = ''
