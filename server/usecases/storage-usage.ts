import type { StorageUsageRepo } from './ports'

export type StorageUsageDeps = { storageUsage: StorageUsageRepo }

type RollbackCleanup = () => Promise<void> | void

// Tracks side effects to undo if a guarded action throws.
export class StorageUsageMutationContext {
  private readonly cleanups: RollbackCleanup[] = []

  onRollback(cleanup: RollbackCleanup): void {
    this.cleanups.push(cleanup)
  }

  async rollbackCleanups(): Promise<void> {
    for (const cleanup of [...this.cleanups].reverse()) {
      await cleanup()
    }
  }
}

// No quota enforcement on this single-user instance — this helper now only
// provides the rollback context for S3 side effects.
export async function withStorageUsageReservation<T>(
  _deps: StorageUsageDeps,
  _inputs: unknown,
  action: (ctx: StorageUsageMutationContext) => Promise<T>,
): Promise<T> {
  const ctx = new StorageUsageMutationContext()
  try {
    return await action(ctx)
  } catch (error) {
    let rollbackError: unknown
    try {
      await ctx.rollbackCleanups()
    } catch (err) {
      rollbackError = err
    }
    if (rollbackError) throw rollbackError
    throw error
  }
}
