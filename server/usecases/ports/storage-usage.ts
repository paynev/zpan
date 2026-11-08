export interface StorageUsageReservation {
  storageId: string
  bytes: number
}

export interface StorageUsageRepo {
  // Decrement storage `used` counters for the given reservations (floored at 0).
  rollbackReservations(reservations: Iterable<StorageUsageReservation | null>): Promise<void>
  // Recompute storages' `used` from live matter/image rows.
  reconcile(storageIds?: Iterable<string>): Promise<void>
}
