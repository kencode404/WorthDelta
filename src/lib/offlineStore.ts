import { fetchMyrRate } from './exchangeRate'
import { supabase } from './supabase'
import type {
  CategoryType,
  ExpenseGroup,
  FinancialCategory,
  HistoryFile,
  LedgerEntry,
  MonthlyRecord,
} from '../types'

const DATABASE_NAME = 'worthdelta-offline'
const DATABASE_VERSION = 4
const SNAPSHOT_STORE = 'snapshots'
const CATEGORY_MUTATION_STORE = 'category-mutations'
const MUTATION_STORE = 'mutations'
const ENTRY_MUTATION_STORE = 'entry-mutations'
const SYNC_CHUNK_SIZE = 250

export interface OfflineSnapshot {
  user_id: string
  expense_groups: ExpenseGroup[]
  categories: FinancialCategory[]
  records: MonthlyRecord[]
  entries: LedgerEntry[]
  updated_at: number
}

interface PendingRecordMutation {
  id: string
  user_id: string
  category_type: CategoryType
  category_name: string
  category_sort_order: number
  expense_group_id: string | null
  local_category_id: string
  local_record_id: string
  period: string
  amount: number
  note: string | null
  source: string
  updated_at: number
}

interface PendingCategoryMutation {
  id: string
  user_id: string
  category_type: CategoryType
  category_name: string
  category_sort_order: number
  expense_group_id: string | null
  local_category_id: string
  updated_at: number
}

interface PendingEntryMutation {
  queue_id: string
  id: string
  user_id: string
  category_type: CategoryType
  category_name: string
  category_sort_order: number
  expense_group_id: string | null
  local_category_id: string
  entry_date: string
  period: string
  amount: number
  description: string
  source_type: 'manual' | 'google_sheets'
  source_sheet: string | null
  source_cell: string | null
  source_formula: string | null
  external_key: string | null
  /** set when the entry was keyed in a foreign currency while offline */
  currency: string | null
  original_amount: number | null
  needs_rate: boolean
  updated_at: number
}

interface QueueRecordInput {
  userId: string
  categoryType: CategoryType
  categoryName: string
  categorySortOrder: number
  expenseGroupId?: string | null
  period: string
  amount: number
  note?: string | null
  source?: string
}

interface QueueCategoryInput {
  userId: string
  categoryType: CategoryType
  categoryName: string
  categorySortOrder: number
  expenseGroupId?: string | null
}

interface QueueEntryInput extends QueueRecordInput {
  entryId?: string
  entryDate: string
  description: string
  sourceType?: 'manual' | 'google_sheets'
  sourceSheet?: string | null
  sourceCell?: string | null
  sourceFormula?: string | null
  externalKey?: string | null
  currency?: string | null
  originalAmount?: number | null
  needsRate?: boolean
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
      if (!database.objectStoreNames.contains(CATEGORY_MUTATION_STORE)) {
        const store = database.createObjectStore(CATEGORY_MUTATION_STORE, { keyPath: 'id' })
        store.createIndex('user_id', 'user_id')
      }
      if (!database.objectStoreNames.contains(MUTATION_STORE)) {
        const store = database.createObjectStore(MUTATION_STORE, { keyPath: 'id' })
        store.createIndex('user_id', 'user_id')
      }
      if (!database.objectStoreNames.contains(ENTRY_MUTATION_STORE)) {
        const store = database.createObjectStore(ENTRY_MUTATION_STORE, { keyPath: 'queue_id' })
        store.createIndex('user_id', 'user_id')
      }
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
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
  return { user_id: userId, expense_groups: [], categories: [], records: [], entries: [], updated_at: Date.now() }
}

function normalizeSnapshot(snapshot: OfflineSnapshot): OfflineSnapshot {
  snapshot.expense_groups ??= []
  snapshot.expense_groups.forEach((group) => { group.category_type ??= 'expense' })
  snapshot.entries ??= []
  snapshot.categories.forEach((category) => {
    category.expense_group_id ??= null
    category.archived_at ??= null
  })
  return snapshot
}

function normalizedName(name: string) {
  return name.trim().toLocaleLowerCase('en')
}

function categoryKey(type: CategoryType, name: string) {
  return `${type}|${normalizedName(name)}`
}

const plannedExpenseNames = new Set([
  '房租+管理費/家用',
  '水費',
  '電費(每單月1次)',
  '電話費/網絡',
  '學貸',
  '貸款（車/房/其他）',
  '健身房',
  '訂閱服務',
  '保費(意外/醫療/車險)',
  '鋼琴課程',
].map(normalizedName))

function importedExpenseGroupId(snapshot: OfflineSnapshot, categoryName: string) {
  const groups = [...snapshot.expense_groups].sort((a, b) => a.sort_order - b.sort_order)
  return plannedExpenseNames.has(normalizedName(categoryName))
    ? groups[0]?.id ?? null
    : groups[1]?.id ?? groups[0]?.id ?? null
}

function mutationKey(userId: string, type: CategoryType, name: string, period: string) {
  return `${userId}|${categoryKey(type, name)}|${period}`
}

function sortSnapshot(snapshot: OfflineSnapshot) {
  snapshot.categories.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  snapshot.records.sort((a, b) => b.period.localeCompare(a.period))
  snapshot.entries.sort((a, b) =>
    b.entry_date.localeCompare(a.entry_date) ||
    (b.created_at ?? '').localeCompare(a.created_at ?? '') ||
    b.id.localeCompare(a.id),
  )
  snapshot.updated_at = Date.now()
  return snapshot
}

function ensureCategory(
  snapshot: OfflineSnapshot,
  mutation: Pick<PendingCategoryMutation, 'category_type' | 'category_name' | 'category_sort_order' | 'expense_group_id' | 'local_category_id' | 'user_id'>,
) {
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
      expense_group_id: mutation.expense_group_id,
    }
    snapshot.categories.push(category)
  } else if (category.category_type === 'expense') {
    category.expense_group_id = mutation.expense_group_id
  }
  return category
}

function applyCategoryMutation(snapshot: OfflineSnapshot, mutation: PendingCategoryMutation) {
  ensureCategory(snapshot, mutation)
  return sortSnapshot(snapshot)
}

function applyRecordMutation(snapshot: OfflineSnapshot, mutation: PendingRecordMutation) {
  const category = ensureCategory(snapshot, mutation)
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
    financial_categories: { name: category.name, category_type: category.category_type, expense_group_id: category.expense_group_id },
  }
  if (existingRecordIndex >= 0) snapshot.records[existingRecordIndex] = nextRecord
  else snapshot.records.push(nextRecord)
  return sortSnapshot(snapshot)
}

function applyEntryMutation(snapshot: OfflineSnapshot, mutation: PendingEntryMutation) {
  const category = ensureCategory(snapshot, mutation)
  const existingIndex = snapshot.entries.findIndex((entry) =>
    mutation.external_key ? entry.external_key === mutation.external_key : entry.id === mutation.id,
  )
  const existing = existingIndex >= 0 ? snapshot.entries[existingIndex] : undefined
  const nextEntry: LedgerEntry = {
    id: existing?.id ?? mutation.id,
    user_id: mutation.user_id,
    category_id: category.id,
    entry_date: mutation.entry_date,
    period: mutation.period,
    amount: mutation.amount,
    description: mutation.description,
    source_type: mutation.source_type,
    source_sheet: mutation.source_sheet,
    source_cell: mutation.source_cell,
    source_formula: mutation.source_formula,
    external_key: mutation.external_key,
    created_at: existing?.created_at ?? new Date(mutation.updated_at).toISOString(),
    updated_at: new Date(mutation.updated_at).toISOString(),
    financial_categories: { name: category.name, category_type: category.category_type, expense_group_id: category.expense_group_id },
  }
  if (existingIndex >= 0) snapshot.entries[existingIndex] = nextEntry
  else snapshot.entries.push(nextEntry)
  return sortSnapshot(snapshot)
}

function createRecordMutation(snapshot: OfflineSnapshot, input: QueueRecordInput): PendingRecordMutation {
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
    expense_group_id: category?.expense_group_id ?? input.expenseGroupId ?? null,
    local_category_id: category?.id ?? crypto.randomUUID(),
    local_record_id: existingRecord?.id ?? crypto.randomUUID(),
    period: input.period,
    amount: input.amount,
    note: input.note ?? null,
    source: input.source ?? 'manual',
    updated_at: Date.now(),
  }
}

function createCategoryMutation(snapshot: OfflineSnapshot, input: QueueCategoryInput): PendingCategoryMutation {
  const name = input.categoryName.trim()
  const existing = snapshot.categories.find(
    (item) => categoryKey(item.category_type, item.name) === categoryKey(input.categoryType, name),
  )
  return {
    id: `${input.userId}|${categoryKey(input.categoryType, name)}`,
    user_id: input.userId,
    category_type: input.categoryType,
    category_name: name,
    category_sort_order: existing?.sort_order ?? input.categorySortOrder,
    expense_group_id: existing?.expense_group_id ?? input.expenseGroupId ?? null,
    local_category_id: existing?.id ?? crypto.randomUUID(),
    updated_at: Date.now(),
  }
}

function createEntryMutation(snapshot: OfflineSnapshot, input: QueueEntryInput): PendingEntryMutation {
  const name = input.categoryName.trim()
  const category = snapshot.categories.find(
    (item) => categoryKey(item.category_type, item.name) === categoryKey(input.categoryType, name),
  )
  const id = input.entryId ?? crypto.randomUUID()
  const externalKey = input.externalKey ?? null
  return {
    queue_id: externalKey ? `${input.userId}|${externalKey}` : id,
    id,
    user_id: input.userId,
    category_type: input.categoryType,
    category_name: name,
    category_sort_order: category?.sort_order ?? input.categorySortOrder,
    expense_group_id: category?.expense_group_id ?? input.expenseGroupId ?? null,
    local_category_id: category?.id ?? crypto.randomUUID(),
    entry_date: input.entryDate,
    period: input.period,
    amount: input.amount,
    description: input.description.trim(),
    source_type: input.sourceType ?? 'manual',
    source_sheet: input.sourceSheet ?? null,
    source_cell: input.sourceCell ?? null,
    source_formula: input.sourceFormula ?? null,
    external_key: externalKey,
    currency: input.currency ?? null,
    original_amount: input.originalAmount ?? null,
    needs_rate: input.needsRate ?? false,
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
  recordMutations: PendingRecordMutation[],
  entryMutations: PendingEntryMutation[],
  categoryMutations: PendingCategoryMutation[] = [],
) {
  const database = await openDatabase()
  const transaction = database.transaction(
    [SNAPSHOT_STORE, CATEGORY_MUTATION_STORE, MUTATION_STORE, ENTRY_MUTATION_STORE],
    'readwrite',
  )
  transaction.objectStore(SNAPSHOT_STORE).put(snapshot)
  const categoryStore = transaction.objectStore(CATEGORY_MUTATION_STORE)
  categoryMutations.forEach((mutation) => categoryStore.put(mutation))
  const recordStore = transaction.objectStore(MUTATION_STORE)
  recordMutations.forEach((mutation) => recordStore.put(mutation))
  const entryStore = transaction.objectStore(ENTRY_MUTATION_STORE)
  entryMutations.forEach((mutation) => entryStore.put(mutation))
  await transactionComplete(transaction)
}

async function pendingCategoryMutations(userId: string) {
  const database = await openDatabase()
  const transaction = database.transaction(CATEGORY_MUTATION_STORE, 'readonly')
  const mutations = await requestResult(
    transaction.objectStore(CATEGORY_MUTATION_STORE).index('user_id').getAll(userId),
  ) as PendingCategoryMutation[]
  await transactionComplete(transaction)
  return mutations.sort((a, b) => a.updated_at - b.updated_at)
}

async function pendingRecordMutations(userId: string) {
  const database = await openDatabase()
  const transaction = database.transaction(MUTATION_STORE, 'readonly')
  const mutations = await requestResult(
    transaction.objectStore(MUTATION_STORE).index('user_id').getAll(userId),
  ) as PendingRecordMutation[]
  await transactionComplete(transaction)
  return mutations.sort((a, b) => a.updated_at - b.updated_at)
}

async function pendingEntryMutations(userId: string) {
  const database = await openDatabase()
  const transaction = database.transaction(ENTRY_MUTATION_STORE, 'readonly')
  const mutations = await requestResult(
    transaction.objectStore(ENTRY_MUTATION_STORE).index('user_id').getAll(userId),
  ) as PendingEntryMutation[]
  await transactionComplete(transaction)
  return mutations.sort((a, b) => a.updated_at - b.updated_at)
}

async function clearSyncedMutations(
  categoryMutations: PendingCategoryMutation[],
  recordMutations: PendingRecordMutation[],
  entryMutations: PendingEntryMutation[],
) {
  if (categoryMutations.length === 0 && recordMutations.length === 0 && entryMutations.length === 0) return
  const database = await openDatabase()
  const transaction = database.transaction(
    [CATEGORY_MUTATION_STORE, MUTATION_STORE, ENTRY_MUTATION_STORE],
    'readwrite',
  )
  const categoryStore = transaction.objectStore(CATEGORY_MUTATION_STORE)
  const recordStore = transaction.objectStore(MUTATION_STORE)
  const entryStore = transaction.objectStore(ENTRY_MUTATION_STORE)
  categoryMutations.forEach((mutation) => {
    const request = categoryStore.get(mutation.id)
    request.onsuccess = () => {
      const current = request.result as PendingCategoryMutation | undefined
      if (current?.updated_at === mutation.updated_at) categoryStore.delete(mutation.id)
    }
  })
  recordMutations.forEach((mutation) => {
    const request = recordStore.get(mutation.id)
    request.onsuccess = () => {
      const current = request.result as PendingRecordMutation | undefined
      if (current?.updated_at === mutation.updated_at) recordStore.delete(mutation.id)
    }
  })
  entryMutations.forEach((mutation) => {
    const request = entryStore.get(mutation.queue_id)
    request.onsuccess = () => {
      const current = request.result as PendingEntryMutation | undefined
      if (current?.updated_at === mutation.updated_at) entryStore.delete(mutation.queue_id)
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
  return snapshot ? normalizeSnapshot(snapshot) : undefined
}

export async function getPendingChangeCount(userId: string) {
  const [categories, records, entries] = await Promise.all([
    pendingCategoryMutations(userId),
    pendingRecordMutations(userId),
    pendingEntryMutations(userId),
  ])
  return categories.length + records.length + entries.length
}

export async function queueCategory(input: QueueCategoryInput) {
  const snapshot = (await getOfflineSnapshot(input.userId)) ?? emptySnapshot(input.userId)
  const mutation = createCategoryMutation(snapshot, input)
  applyCategoryMutation(snapshot, mutation)
  await saveSnapshotAndMutations(snapshot, [], [], [mutation])
  return { snapshot, pendingCount: await getPendingChangeCount(input.userId) }
}

export async function queueLedgerEntry(input: QueueEntryInput) {
  const snapshot = (await getOfflineSnapshot(input.userId)) ?? emptySnapshot(input.userId)
  const existingEntry = input.entryId
    ? snapshot.entries.find((entry) => entry.id === input.entryId)
    : undefined
  if (input.entryId && !existingEntry) throw new Error('This entry is no longer available to edit.')
  const existingMonthly = snapshot.records.find((record) =>
    record.period === input.period &&
    record.financial_categories?.category_type === input.categoryType &&
    normalizedName(record.financial_categories.name) === normalizedName(input.categoryName),
  )
  const entryMutation = createEntryMutation(snapshot, input)
  const recordMutation = createRecordMutation(snapshot, {
    ...input,
    amount: Number(existingMonthly?.amount ?? 0) + input.amount - Number(existingEntry?.amount ?? 0),
    source: 'ledger',
  })
  applyEntryMutation(snapshot, entryMutation)
  applyRecordMutation(snapshot, recordMutation)
  await saveSnapshotAndMutations(snapshot, [recordMutation], [entryMutation])
  return { snapshot, pendingCount: await getPendingChangeCount(input.userId) }
}

export async function queueHistoryImport(payload: HistoryFile, userId: string) {
  const snapshot = (await getOfflineSnapshot(userId)) ?? emptySnapshot(userId)
  const categoryDetails = new Map(
    payload.categories.map((category) => [categoryKey(category.type, category.name), category]),
  )
  const queuedRecords = new Map<string, PendingRecordMutation>()
  const queuedEntries = new Map<string, PendingEntryMutation>()
  payload.records.forEach((record) => {
    const details = categoryDetails.get(categoryKey(record.type, record.category))
    if (!details) throw new Error(`Category not found: ${record.category}`)
    const mutation = createRecordMutation(snapshot, {
      userId,
      categoryType: record.type,
      categoryName: record.category,
      categorySortOrder: details.sort_order,
      expenseGroupId: record.type === 'expense' ? importedExpenseGroupId(snapshot, record.category) : null,
      period: record.period,
      amount: record.amount,
      source: `Google Sheets · ${record.source_sheet}:${record.source_row}`,
    })
    applyRecordMutation(snapshot, mutation)
    queuedRecords.set(mutation.id, mutation)
  })
  payload.entries?.forEach((entry) => {
    const details = categoryDetails.get(categoryKey(entry.type, entry.category))
    if (!details) throw new Error(`Category not found: ${entry.category}`)
    const mutation = createEntryMutation(snapshot, {
      userId,
      categoryType: entry.type,
      categoryName: entry.category,
      categorySortOrder: details.sort_order,
      expenseGroupId: entry.type === 'expense' ? importedExpenseGroupId(snapshot, entry.category) : null,
      period: entry.period,
      entryDate: entry.entry_date,
      amount: entry.amount,
      description: entry.description,
      sourceType: 'google_sheets',
      sourceSheet: entry.source_sheet,
      sourceCell: entry.source_cell,
      sourceFormula: entry.source_formula,
      externalKey: entry.external_key,
    })
    applyEntryMutation(snapshot, mutation)
    queuedEntries.set(mutation.queue_id, mutation)
  })
  await saveSnapshotAndMutations(snapshot, [...queuedRecords.values()], [...queuedEntries.values()])
  return {
    snapshot,
    categories: payload.categories.length,
    records: payload.records.length,
    entries: payload.entries?.length ?? 0,
    pendingCount: await getPendingChangeCount(userId),
  }
}

export async function syncPendingChanges(userId: string) {
  const [categoryMutations, recordMutations, entryMutations] = await Promise.all([
    pendingCategoryMutations(userId),
    pendingRecordMutations(userId),
    pendingEntryMutations(userId),
  ])
  if (categoryMutations.length === 0 && recordMutations.length === 0 && entryMutations.length === 0) return 0
  if (!navigator.onLine) throw new Error('WorthDelta is offline.')
  const allMutations = [...categoryMutations, ...recordMutations, ...entryMutations]
  const uniqueCategories = new Map<string, (typeof allMutations)[number]>()
  allMutations.forEach((mutation) => {
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
        expense_group_id: mutation.category_type === 'expense' || mutation.category_type === 'asset' ? mutation.expense_group_id : null,
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
  const categoryIdFor = (mutation: (typeof allMutations)[number]) => {
    const id = remoteCategoryIds.get(categoryKey(mutation.category_type, mutation.category_name))
    if (!id) throw new Error(`Could not sync category: ${mutation.category_name}`)
    return id
  }
  const recordRows = recordMutations.map((mutation) => ({
    user_id: mutation.user_id,
    category_id: categoryIdFor(mutation),
    period: mutation.period,
    amount: mutation.amount,
    note: mutation.note,
    source: mutation.source,
  }))
  for (let index = 0; index < recordRows.length; index += SYNC_CHUNK_SIZE) {
    const { error } = await supabase
      .from('worthdelta_monthly_records')
      .upsert(recordRows.slice(index, index + SYNC_CHUNK_SIZE), {
        onConflict: 'user_id,category_id,period',
      })
    if (error) throw error
  }
  const awaitingRate = entryMutations.filter((mutation) => mutation.needs_rate && mutation.currency)
  if (awaitingRate.length > 0) {
    const rates = new Map<string, number>()
    for (const code of new Set(awaitingRate.map((mutation) => mutation.currency as string))) {
      try {
        const { rate } = await fetchMyrRate(code)
        rates.set(code, rate)
      } catch {
        throw new Error(`No source could give today's ${code} rate, so ${awaitingRate.length === 1 ? 'that entry stays' : 'those entries stay'} queued. They will convert on the next sync.`)
      }
    }
    awaitingRate.forEach((mutation) => {
      const rate = rates.get(mutation.currency as string)
      if (!rate) return
      const converted = Number(((mutation.original_amount ?? 0) * rate).toFixed(2))
      const difference = converted - mutation.amount
      mutation.amount = converted
      mutation.needs_rate = false
      // the month's category total was queued with the estimate, so move it by the gap
      const record = recordMutations.find((item) =>
        item.period === mutation.period &&
        item.category_type === mutation.category_type &&
        normalizedName(item.category_name) === normalizedName(mutation.category_name),
      )
      if (record) record.amount = Number((record.amount + difference).toFixed(2))
    })
  }

  const entryRows = entryMutations.map((mutation) => ({
    id: mutation.id,
    user_id: mutation.user_id,
    category_id: categoryIdFor(mutation),
    entry_date: mutation.entry_date,
    period: mutation.period,
    amount: mutation.amount,
    description: mutation.description,
    source_type: mutation.source_type,
    source_sheet: mutation.source_sheet,
    source_cell: mutation.source_cell,
    source_formula: mutation.source_formula,
    external_key: mutation.external_key,
  }))
  const importedRows = entryRows.filter((row) => row.external_key)
  const manualRows = entryRows.filter((row) => !row.external_key)
  for (let index = 0; index < importedRows.length; index += SYNC_CHUNK_SIZE) {
    const { error } = await supabase
      .from('worthdelta_ledger_entries')
      .upsert(importedRows.slice(index, index + SYNC_CHUNK_SIZE), {
        onConflict: 'user_id,external_key',
      })
    if (error) throw error
  }
  for (let index = 0; index < manualRows.length; index += SYNC_CHUNK_SIZE) {
    const { error } = await supabase
      .from('worthdelta_ledger_entries')
      .upsert(manualRows.slice(index, index + SYNC_CHUNK_SIZE), { onConflict: 'id' })
    if (error) throw error
  }
  await clearSyncedMutations(categoryMutations, recordMutations, entryMutations)
  return categoryMutations.length + recordMutations.length + entryMutations.length
}

async function fetchAllMonthlyRecords() {
  const rows: MonthlyRecord[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('worthdelta_monthly_records')
      .select('*, financial_categories:worthdelta_financial_categories(name, category_type, expense_group_id)')
      .order('period', { ascending: false })
      .range(from, from + 999)
    if (error) throw error
    rows.push(...(data as unknown as MonthlyRecord[]))
    if (data.length < 1000) return rows
  }
}

async function fetchAllLedgerEntries() {
  const rows: LedgerEntry[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('worthdelta_ledger_entries')
      .select('*, financial_categories:worthdelta_financial_categories(name, category_type, expense_group_id)')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, from + 999)
    if (error) throw error
    rows.push(...(data as unknown as LedgerEntry[]))
    if (data.length < 1000) return rows
  }
}

export async function refreshRemoteSnapshot(userId: string) {
  const [groupResult, categoryResult, remoteRecords, remoteEntries] = await Promise.all([
    supabase.from('worthdelta_expense_groups').select('*').order('sort_order'),
    supabase.from('worthdelta_financial_categories').select('*').order('sort_order'),
    fetchAllMonthlyRecords(),
    fetchAllLedgerEntries(),
  ])
  if (groupResult.error) throw groupResult.error
  if (categoryResult.error) throw categoryResult.error
  const snapshot: OfflineSnapshot = {
    user_id: userId,
    expense_groups: (groupResult.data as ExpenseGroup[]).map((group) => ({ ...group, category_type: group.category_type ?? 'expense' })),
    categories: categoryResult.data as FinancialCategory[],
    records: remoteRecords,
    entries: remoteEntries,
    updated_at: Date.now(),
  }
  const [remainingCategories, remainingRecords, remainingEntries] = await Promise.all([
    pendingCategoryMutations(userId),
    pendingRecordMutations(userId),
    pendingEntryMutations(userId),
  ])
  remainingCategories.forEach((mutation) => applyCategoryMutation(snapshot, mutation))
  remainingRecords.forEach((mutation) => applyRecordMutation(snapshot, mutation))
  remainingEntries.forEach((mutation) => applyEntryMutation(snapshot, mutation))
  await saveSnapshot(snapshot)
  return {
    snapshot,
    pendingCount: remainingCategories.length + remainingRecords.length + remainingEntries.length,
  }
}

export function isNetworkError(error: unknown) {
  if (!navigator.onLine) return true
  if (!(error instanceof Error)) return false
  return (
    error.name.includes('Fetch') ||
    /failed to fetch|network|offline|load failed/i.test(error.message)
  )
}
