import { supabase } from './supabase'
import type { CategoryType, FinancialCategory, HistoryFile, MonthlyRecord } from '../types'

const DATABASE_NAME = 'worthdelta-offline'
const DATABASE_VERSION = 1
const SNAPSHOT_STORE = 'snapshots'
const MUTATION_STORE = 'mutations'
const SYNC_CHUNK_SIZE = 250

export interface OfflineSnapshot {
  user_id: string
  categories: FinancialCategory[]
  records: MonthlyRecord[]
  updated_at: number
}

interface PendingRecordMutation {
  id: string
  user_id: string
  category_type: CategoryType
  category_name: string
  category_sort_order: number
  local_category_id: string
  local_record_id: string
  period: string
  amount: number
  note: string | null
  source: string
  updated_at: number
}

interface QueueRecordInput {
  userId: string
  categoryType: CategoryType
  categoryName: string
  categorySortOrder: number
  period: string
  amount: number
  note?: string | null
  source?: string
}

let databasePromise: Promise<IDBDatabase> | undefined

function openDatabase() {
  if (databasePromise) return databasePromise

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'user_id' })
      }
      if (!database.objectStoreNames.contains(MUTATION_STORE)) {
        const store = database.createObjectStore(MUTATION_STORE, { keyPath: 'id' })
        store.createIndex('user_id', 'user_id')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('WorthDelta offline storage is blocked by another tab.'))
  })

  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Offline storage transaction aborted.'))
  })
}

function emptySnapshot(userId: string): OfflineSnapshot {
  return { user_id: userId, categories: [], records: [], updated_at: Date.now() }
}

function normalizedName(name: string) {
  return name.trim().toLocaleLowerCase('en')
}

function categoryKey(type: CategoryType, name: string) {
  return `${type}|${normalizedName(name)}`
}

function mutationKey(userId: string, type: CategoryType, name: string, period: string) {
  return `${userId}|${categoryKey(type, name)}|${period}`
}

function sortSnapshot(snapshot: OfflineSnapshot) {
  snapshot.categories.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  snapshot.records.sort((a, b) => b.period.localeCompare(a.period))
  snapshot.updated_at = Date.now()
  return snapshot
}

function applyMutation(snapshot: OfflineSnapshot, mutation: PendingRecordMutation) {
  const wantedCategoryKey = categoryKey(mutation.category_type, mutation.category_name)
  let category = snapshot.categories.find(
    (item) => categoryKey(item.category_type, item.name) === wantedCategoryKey,
  )

  if (!category) {
    category = {
      id: mutation.local_category_id,
      user_id: mutation.user_id,
      category_type: mutation.category_type,
      name: mutation.category_name,
      sort_order: mutation.category_sort_order,
    }
    snapshot.categories.push(category)
  }

  const existingRecordIndex = snapshot.records.findIndex(
    (record) =>
      record.period === mutation.period &&
      record.financial_categories?.category_type === mutation.category_type &&
      normalizedName(record.financial_categories.name) === normalizedName(mutation.category_name),
  )
  const existingRecord = existingRecordIndex >= 0 ? snapshot.records[existingRecordIndex] : undefined
  const nextRecord: MonthlyRecord = {
    id: existingRecord?.id ?? mutation.local_record_id,
    user_id: mutation.user_id,
    category_id: category.id,
    period: mutation.period,
    amount: mutation.amount,
    note: mutation.note,
    source: mutation.source,
    financial_categories: {
      name: category.name,
      category_type: category.category_type,
    },
  }

  if (existingRecordIndex >= 0) snapshot.records[existingRecordIndex] = nextRecord
  else snapshot.records.push(nextRecord)

  return sortSnapshot(snapshot)
}

function createMutation(snapshot: OfflineSnapshot, input: QueueRecordInput): PendingRecordMutation {
  const name = input.categoryName.trim()
  const category = snapshot.categories.find(
    (item) => categoryKey(item.category_type, item.name) === categoryKey(input.categoryType, name),
  )
  const existingRecord = snapshot.records.find(
    (record) =>
      record.period === input.period &&
      record.financial_categories?.category_type === input.categoryType &&
      normalizedName(record.financial_categories.name) === normalizedName(name),
  )

  return {
    id: mutationKey(input.userId, input.categoryType, name, input.period),
    user_id: input.userId,
    category_type: input.categoryType,
    category_name: name,
    category_sort_order: category?.sort_order ?? input.categorySortOrder,
    local_category_id: category?.id ?? crypto.randomUUID(),
    local_record_id: existingRecord?.id ?? crypto.randomUUID(),
    period: input.period,
    amount: input.amount,
    note: input.note ?? null,
    source: input.source ?? 'manual',
    updated_at: Date.now(),
  }
}

async function saveSnapshot(snapshot: OfflineSnapshot) {
  const database = await openDatabase()
  const transaction = database.transaction(SNAPSHOT_STORE, 'readwrite')
  transaction.objectStore(SNAPSHOT_STORE).put(snapshot)
  await transactionComplete(transaction)
}

async function saveSnapshotAndMutations(
  snapshot: OfflineSnapshot,
  mutations: PendingRecordMutation[],
) {
  const database = await openDatabase()
  const transaction = database.transaction([SNAPSHOT_STORE, MUTATION_STORE], 'readwrite')
  transaction.objectStore(SNAPSHOT_STORE).put(snapshot)
  const mutationStore = transaction.objectStore(MUTATION_STORE)
  mutations.forEach((mutation) => mutationStore.put(mutation))
  await transactionComplete(transaction)
}

async function pendingMutations(userId: string) {
  const database = await openDatabase()
  const transaction = database.transaction(MUTATION_STORE, 'readonly')
  const mutations = await requestResult(
    transaction.objectStore(MUTATION_STORE).index('user_id').getAll(userId),
  ) as PendingRecordMutation[]
  await transactionComplete(transaction)
  return mutations.sort((a, b) => a.updated_at - b.updated_at)
}

async function clearSyncedMutations(mutations: PendingRecordMutation[]) {
  if (mutations.length === 0) return
  const database = await openDatabase()
  const transaction = database.transaction(MUTATION_STORE, 'readwrite')
  const store = transaction.objectStore(MUTATION_STORE)

  mutations.forEach((mutation) => {
    const request = store.get(mutation.id)
    request.onsuccess = () => {
      const current = request.result as PendingRecordMutation | undefined
      if (current?.updated_at === mutation.updated_at) store.delete(mutation.id)
    }
  })

  await transactionComplete(transaction)
}

export async function getOfflineSnapshot(userId: string) {
  const database = await openDatabase()
  const transaction = database.transaction(SNAPSHOT_STORE, 'readonly')
  const snapshot = await requestResult(
    transaction.objectStore(SNAPSHOT_STORE).get(userId),
  ) as OfflineSnapshot | undefined
  await transactionComplete(transaction)
  return snapshot
}

export async function getPendingChangeCount(userId: string) {
  return (await pendingMutations(userId)).length
}

export async function queueRecordChange(input: QueueRecordInput) {
  const snapshot = (await getOfflineSnapshot(input.userId)) ?? emptySnapshot(input.userId)
  const mutation = createMutation(snapshot, input)
  applyMutation(snapshot, mutation)
  await saveSnapshotAndMutations(snapshot, [mutation])
  return { snapshot, pendingCount: await getPendingChangeCount(input.userId) }
}

export async function queueHistoryImport(payload: HistoryFile, userId: string) {
  const snapshot = (await getOfflineSnapshot(userId)) ?? emptySnapshot(userId)
  const categoryDetails = new Map(
    payload.categories.map((category) => [categoryKey(category.type, category.name), category]),
  )
  const queued = new Map<string, PendingRecordMutation>()

  payload.records.forEach((record) => {
    const details = categoryDetails.get(categoryKey(record.type, record.category))
    if (!details) throw new Error(`Category not found: ${record.category}`)
    const mutation = createMutation(snapshot, {
      userId,
      categoryType: record.type,
      categoryName: record.category,
      categorySortOrder: details.sort_order,
      period: record.period,
      amount: record.amount,
      source: `Google Sheets · ${record.source_sheet}:${record.source_row}`,
    })
    applyMutation(snapshot, mutation)
    queued.set(mutation.id, mutation)
  })

  await saveSnapshotAndMutations(snapshot, [...queued.values()])
  return {
    snapshot,
    categories: payload.categories.length,
    records: payload.records.length,
    pendingCount: await getPendingChangeCount(userId),
  }
}

export async function syncPendingChanges(userId: string) {
  const mutations = await pendingMutations(userId)
  if (mutations.length === 0) return 0
  if (!navigator.onLine) throw new Error('WorthDelta is offline.')

  const uniqueCategories = new Map<string, PendingRecordMutation>()
  mutations.forEach((mutation) => {
    uniqueCategories.set(categoryKey(mutation.category_type, mutation.category_name), mutation)
  })

  const { data: categoryData, error: categoryError } = await supabase
    .from('worthdelta_financial_categories')
    .upsert(
      [...uniqueCategories.values()].map((mutation) => ({
        user_id: mutation.user_id,
        category_type: mutation.category_type,
        name: mutation.category_name,
        sort_order: mutation.category_sort_order,
      })),
      { onConflict: 'user_id,category_type,name' },
    )
    .select('*')

  if (categoryError) throw categoryError

  const remoteCategoryIds = new Map(
    (categoryData as FinancialCategory[]).map((category) => [
      categoryKey(category.category_type, category.name),
      category.id,
    ]),
  )
  const rows = mutations.map((mutation) => {
    const categoryId = remoteCategoryIds.get(
      categoryKey(mutation.category_type, mutation.category_name),
    )
    if (!categoryId) throw new Error(`Could not sync category: ${mutation.category_name}`)
    return {
      user_id: mutation.user_id,
      category_id: categoryId,
      period: mutation.period,
      amount: mutation.amount,
      note: mutation.note,
      source: mutation.source,
    }
  })

  for (let index = 0; index < rows.length; index += SYNC_CHUNK_SIZE) {
    const { error } = await supabase
      .from('worthdelta_monthly_records')
      .upsert(rows.slice(index, index + SYNC_CHUNK_SIZE), {
        onConflict: 'user_id,category_id,period',
      })
    if (error) throw error
  }

  await clearSyncedMutations(mutations)
  return mutations.length
}

export async function refreshRemoteSnapshot(userId: string) {
  const [categoryResult, recordResult] = await Promise.all([
    supabase.from('worthdelta_financial_categories').select('*').order('sort_order'),
    supabase
      .from('worthdelta_monthly_records')
      .select('*, financial_categories:worthdelta_financial_categories(name, category_type)')
      .order('period', { ascending: false }),
  ])
  const error = categoryResult.error ?? recordResult.error
  if (error) throw error

  const snapshot: OfflineSnapshot = {
    user_id: userId,
    categories: categoryResult.data as FinancialCategory[],
    records: recordResult.data as unknown as MonthlyRecord[],
    updated_at: Date.now(),
  }
  const remainingMutations = await pendingMutations(userId)
  remainingMutations.forEach((mutation) => applyMutation(snapshot, mutation))
  await saveSnapshot(snapshot)
  return { snapshot, pendingCount: remainingMutations.length }
}

export function isNetworkError(error: unknown) {
  if (!navigator.onLine) return true
  if (!(error instanceof Error)) return false
  return (
    error.name.includes('Fetch') ||
    /failed to fetch|network|offline|load failed/i.test(error.message)
  )
}
