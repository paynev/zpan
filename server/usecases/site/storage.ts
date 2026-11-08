// The storages resource usecase. Owns every business decision behind the
// /api/admin/storages routes — the in-use delete guard — so the http handlers
// only validate input, call these functions, and serialize the result.
// Expected failures come back as a returned AppError the handler throws.
//
// Not to be confused with storage-usage.ts, which is the reusable
// reservation operation consumed by the objects/matter flows. This file is
// the CRUD resource; that one is a cross-resource operation.

import type { CreateStorageInput, PatchStorageInput, ReplaceStorageInput } from '@shared/schemas'
import { type AppError, conflict, type StorageRecord, type StorageRepo, storageNotFound } from '../ports'

export type StorageDeps = {
  storages: StorageRepo
}

export type CreateStorageOutcome = { ok: true; storage: StorageRecord } | { ok: false; error: AppError }

export type UpdateStorageOutcome = { ok: true; storage: StorageRecord } | { ok: false; error: AppError }

export type DeleteStorageOutcome = { ok: true } | { ok: false; error: AppError }

export function listStorages(deps: Pick<StorageDeps, 'storages'>): Promise<{ items: StorageRecord[]; total: number }> {
  return deps.storages.list()
}

export function getStorage(deps: Pick<StorageDeps, 'storages'>, id: string): Promise<StorageRecord | null> {
  return deps.storages.get(id)
}

export async function createStorage(
  deps: StorageDeps,
  params: { input: CreateStorageInput },
): Promise<CreateStorageOutcome> {
  const storage = await deps.storages.create(params.input)
  return { ok: true, storage }
}

export async function replaceStorage(
  deps: StorageDeps,
  params: { id: string; input: ReplaceStorageInput },
): Promise<UpdateStorageOutcome> {
  const storage = await deps.storages.replace(params.id, params.input)
  if (!storage) return { ok: false, error: storageNotFound() }
  return { ok: true, storage }
}

export async function patchStorage(
  deps: StorageDeps,
  params: { id: string; input: PatchStorageInput },
): Promise<UpdateStorageOutcome> {
  const storage = await deps.storages.patch(params.id, params.input)
  if (!storage) return { ok: false, error: storageNotFound() }
  return { ok: true, storage }
}

export async function deleteStorage(deps: StorageDeps, params: { id: string }): Promise<DeleteStorageOutcome> {
  const existing = await deps.storages.get(params.id)
  if (!existing) return { ok: false, error: storageNotFound() }
  const result = await deps.storages.delete(params.id)
  if (result === 'not_found') return { ok: false, error: storageNotFound() }
  if (result === 'in_use') return { ok: false, error: conflict('Storage is referenced by existing files') }
  return { ok: true }
}
