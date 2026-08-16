import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  CheckCircle,
  ChartLineUp,
  CloudArrowUp,
  Database,
  FileArrowUp,
  MagnifyingGlass,
  Money,
  Plus,
  Receipt,
  SignOut,
  SpinnerGap,
  TrendDown,
  TrendUp,
  Wallet,
  WifiSlash,
} from '@phosphor-icons/react'
import { readHistoryFile } from './lib/historyImport'
import {
  getOfflineSnapshot,
  getPendingChangeCount,
  isNetworkError,
  queueHistoryImport,
  queueLedgerEntry,
  refreshRemoteSnapshot,
  syncPendingChanges,
} from './lib/offlineStore'
import { supabase } from './lib/supabase'
import type { CategoryType, FinancialCategory, LedgerEntry, MonthlyRecord } from './types'
import './App.css'

const categoryMeta: Record<CategoryType, { label: string; icon: typeof Wallet }> = {
  asset: { label: 'Assets', icon: Wallet },
  income: { label: 'Income', icon: TrendUp },
  expense: { label: 'Expenses', icon: TrendDown },
  investment: { label: 'Investments', icon: ChartLineUp },
}

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('en-MY', {
    style: 'currency',
    currency: 'MYR',
    maximumFractionDigits: 0,
  }).format(value)

const formatMonth = (period: string) =>
  new Intl.DateTimeFormat('en-MY', { month: 'short', year: 'numeric' }).format(
    new Date(`${period.slice(0, 7)}-02T00:00:00`),
  )

const formatEntryDate = (date: string) =>
  new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(`${date.slice(0, 10)}T00:00:00`),
  )

const HUB_URL = 'https://kencode404.github.io/K-Super-Hub/'
type SyncStatus = 'offline' | 'syncing' | 'pending' | 'synced'

const messageFrom = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) return error.message
  return 'Something went wrong.'
}

function HubRedirect() {
  useEffect(() => {
    const destination = new URL(HUB_URL)
    destination.searchParams.set(
      'next',
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    )
    window.location.replace(destination.href)
  }, [])

  return (
    <main className="boot-screen">
      <span className="brand-mark app-icon-mark" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}worthdelta-icon.png`} alt="" /></span>
      <SpinnerGap className="spin" aria-label="Opening K-Super Hub" />
    </main>
  )
}

function TrendChart({ points, label }: { points: Array<{ period: string; value: number }>; label: string }) {
  if (points.length < 2) return <div className="chart-empty">Add at least two months for {label || 'this category'} to reveal its trend.</div>
  const width = 760
  const height = 230
  const padding = 18
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spread = max - min || 1
  const coordinates = points.map((point, index) => ({
    ...point,
    x: padding + (index / (points.length - 1)) * (width - padding * 2),
    y: height - padding - ((point.value - min) / spread) * (height - padding * 2),
  }))
  const path = coordinates.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} trend from ${formatMonth(points[0].period)} to ${formatMonth(points.at(-1)!.period)}`}>
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--brand)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${path} L ${coordinates.at(-1)!.x} ${height} L ${coordinates[0].x} ${height} Z`} fill="url(#chartFill)" />
        <path d={path} fill="none" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {coordinates.map((point) => <circle key={point.period} cx={point.x} cy={point.y} r="5" fill="var(--surface)" stroke="var(--brand)" strokeWidth="3"><title>{formatMonth(point.period)}: {formatCurrency(point.value)}</title></circle>)}
      </svg>
      <div className="chart-labels"><span>{formatMonth(points[0].period)}</span><span>{formatMonth(points.at(-1)!.period)}</span></div>
    </div>
  )
}

function Dashboard({ session }: { session: Session }) {
  const [categories, setCategories] = useState<FinancialCategory[]>([])
  const [records, setRecords] = useState<MonthlyRecord[]>([])
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(navigator.onLine ? 'synced' : 'offline')
  const [type, setType] = useState<CategoryType>('asset')
  const [categoryName, setCategoryName] = useState('')
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10))
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [ledgerMonth, setLedgerMonth] = useState('')
  const [ledgerSearch, setLedgerSearch] = useState('')
  const [visibleEntries, setVisibleEntries] = useState(50)
  const [chartType, setChartType] = useState<CategoryType>('asset')
  const [chartCategory, setChartCategory] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const showSnapshot = useCallback((snapshot: { categories: FinancialCategory[]; records: MonthlyRecord[]; entries: LedgerEntry[] }) => {
    setCategories(snapshot.categories)
    setRecords(snapshot.records)
    setEntries(snapshot.entries)
  }, [])

  const loadData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)

    try {
      const cached = await getOfflineSnapshot(session.user.id)
      if (cached) showSnapshot(cached)

      const queued = await getPendingChangeCount(session.user.id)
      setPendingCount(queued)
      if (!navigator.onLine) {
        setSyncStatus('offline')
        setLoadError('')
        return
      }

      if (queued > 0) {
        setSyncStatus('syncing')
        await syncPendingChanges(session.user.id)
      }

      const remote = await refreshRemoteSnapshot(session.user.id)
      showSnapshot(remote.snapshot)
      setPendingCount(remote.pendingCount)
      setSyncStatus(remote.pendingCount > 0 ? 'pending' : 'synced')
      setLoadError('')
    } catch (error) {
      const queued = await getPendingChangeCount(session.user.id).catch(() => 0)
      setPendingCount(queued)
      setSyncStatus(navigator.onLine ? 'pending' : 'offline')
      if (isNetworkError(error)) setLoadError('')
      else setLoadError(messageFrom(error))
    } finally {
      setLoading(false)
    }
  }, [session.user.id, showSnapshot])

  useEffect(() => {
    void loadData()
    const handleOnline = () => void loadData(false)
    const handleOffline = () => setSyncStatus('offline')
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [loadData])

  const assetTrend = useMemo(() => {
    const totals = new Map<string, number>()
    records.filter((record) => record.financial_categories?.category_type === 'asset').forEach((record) => {
      totals.set(record.period, (totals.get(record.period) ?? 0) + Number(record.amount))
    })
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([pointPeriod, value]) => ({ period: pointPeriod, value }))
  }, [records])

  const activePeriod = assetTrend.at(-1)?.period ?? records[0]?.period ?? `${entryDate.slice(0, 7)}-01`
  const monthRecords = records.filter((record) => record.period === activePeriod)
  const totalFor = (recordType: CategoryType) => monthRecords
    .filter((record) => record.financial_categories?.category_type === recordType)
    .reduce((total, record) => total + Number(record.amount), 0)
  const assets = totalFor('asset')
  const income = totalFor('income')
  const expenses = totalFor('expense')
  const investments = totalFor('investment')
  const chartCategories = categories.filter((category) => category.category_type === chartType)
  const activeChartCategory = chartCategories.some((category) => category.name === chartCategory)
    ? chartCategory
    : chartCategories[0]?.name ?? ''
  const categoryTrend = records
    .filter((record) =>
      record.financial_categories?.category_type === chartType &&
      record.financial_categories?.name === activeChartCategory,
    )
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((record) => ({ period: record.period, value: Number(record.amount) }))
  const categoryChange = categoryTrend.length > 1
    ? categoryTrend.at(-1)!.value - categoryTrend[0].value
    : 0

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (!categoryName.trim() || !description.trim() || !entryDate || !amount) return
    setSaving(true)
    setNotice('')

    try {
      const queued = await queueLedgerEntry({
        userId: session.user.id,
        categoryType: type,
        categoryName,
        categorySortOrder: categories.length + 1,
        period: `${entryDate.slice(0, 7)}-01`,
        entryDate,
        amount: Number(amount),
        description,
      })
      showSnapshot(queued.snapshot)
      setPendingCount(queued.pendingCount)
      setAmount('')
      setDescription('')

      if (!navigator.onLine) {
        setSyncStatus('offline')
        setNotice('Saved on this device. It will sync automatically when you reconnect.')
        return
      }

      setSyncStatus('syncing')
      await syncPendingChanges(session.user.id)
      const remote = await refreshRemoteSnapshot(session.user.id)
      showSnapshot(remote.snapshot)
      setPendingCount(remote.pendingCount)
      setSyncStatus(remote.pendingCount > 0 ? 'pending' : 'synced')
      setLoadError('')
      setNotice('Detailed entry saved and synced.')
    } catch (error) {
      const queued = await getPendingChangeCount(session.user.id).catch(() => 0)
      setPendingCount(queued)
      setSyncStatus(navigator.onLine ? 'pending' : 'offline')
      setNotice(queued > 0
        ? 'Saved on this device. Sync will retry automatically.'
        : messageFrom(error))
      if (!isNetworkError(error) && queued === 0) setLoadError(messageFrom(error))
    } finally {
      setSaving(false)
    }
  }

  async function handleImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setSaving(true)
    setNotice('Saving your history on this device…')
    try {
      const payload = await readHistoryFile(file)
      const result = await queueHistoryImport(payload, session.user.id)
      showSnapshot(result.snapshot)
      setPendingCount(result.pendingCount)

      if (navigator.onLine) {
        setSyncStatus('syncing')
        setNotice('History saved locally. Syncing it now…')
        await syncPendingChanges(session.user.id)
        const remote = await refreshRemoteSnapshot(session.user.id)
        showSnapshot(remote.snapshot)
        setPendingCount(remote.pendingCount)
        setSyncStatus(remote.pendingCount > 0 ? 'pending' : 'synced')
        setNotice(`Imported and synced ${result.entries.toLocaleString()} traceable entries and ${result.records.toLocaleString()} monthly summaries across ${result.categories} categories.`)
      } else {
        setSyncStatus('offline')
        setNotice(`Imported ${result.entries.toLocaleString()} traceable entries on this device. They will sync when you reconnect.`)
      }
    } catch (importError) {
      const queued = await getPendingChangeCount(session.user.id).catch(() => 0)
      setPendingCount(queued)
      if (queued > 0) {
        setSyncStatus(navigator.onLine ? 'pending' : 'offline')
        setNotice('History is safe on this device. Sync will retry automatically.')
      } else {
        setNotice(importError instanceof Error ? importError.message : 'Import failed.')
      }
    } finally {
      setSaving(false)
      event.target.value = ''
    }
  }

  const filteredCategories = categories.filter((category) => category.category_type === type)
  const ledgerMonths = [...new Set(entries.map((entry) => entry.period.slice(0, 7)))].sort().reverse()
  const filteredEntries = entries.filter((entry) => {
    if (ledgerMonth && entry.period.slice(0, 7) !== ledgerMonth) return false
    const search = ledgerSearch.trim().toLocaleLowerCase('en')
    if (!search) return true
    return [
      entry.description,
      entry.financial_categories?.name,
      entry.source_sheet,
      entry.source_cell,
      entry.source_formula,
    ].some((value) => value?.toLocaleLowerCase('en').includes(search))
  })
  const SyncIcon = syncStatus === 'offline'
    ? WifiSlash
    : syncStatus === 'synced'
      ? CheckCircle
      : CloudArrowUp
  const syncLabel = syncStatus === 'offline'
    ? pendingCount > 0 ? `Offline · ${pendingCount} queued` : 'Offline mode'
    : syncStatus === 'syncing'
      ? `Syncing${pendingCount > 0 ? ` ${pendingCount}` : ''}…`
      : syncStatus === 'pending'
        ? `${pendingCount} waiting to sync`
        : 'Synced'
  const databaseSetupRequired = /schema cache|PGRST205|could not find the table/i.test(loadError)

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <a className="brand brand-light" href={import.meta.env.BASE_URL} aria-label="WorthDelta home"><span className="brand-mark app-icon-mark" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}worthdelta-icon.png`} alt="" /></span><span>WorthDelta</span></a>
        <nav aria-label="Dashboard"><a className="nav-item active" href="#overview"><ChartLineUp aria-hidden="true" />Overview</a><a className="nav-item" href="#records"><Money aria-hidden="true" />Add entry</a><a className="nav-item" href="#ledger"><Receipt aria-hidden="true" />Ledger</a></nav>
        <div className="sidebar-user"><span className="avatar">{(session.user.email?.[0] ?? 'W').toUpperCase()}</span><span><strong>{session.user.user_metadata.full_name ?? 'WorthDelta user'}</strong><small>{session.user.email}</small></span><button type="button" onClick={() => void supabase.auth.signOut()} aria-label="Sign out"><SignOut aria-hidden="true" /></button></div>
      </aside>

      <main className="dashboard-main" id="overview">
        <header className="dashboard-header"><div><p className="eyebrow">Personal finance dashboard</p><h1>Your worth, in motion.</h1><p>Latest asset snapshot: {formatMonth(activePeriod)}</p></div><div className="header-actions"><span className={`sync-status ${syncStatus}`} role="status" aria-live="polite"><SyncIcon className={syncStatus === 'syncing' ? 'spin' : ''} aria-hidden="true" />{syncLabel}</span><button className="outline-button" type="button" onClick={() => fileInput.current?.click()} disabled={saving}><FileArrowUp aria-hidden="true" />Import history</button><input ref={fileInput} className="sr-only" type="file" accept="application/json,.json" onChange={handleImport} /></div></header>

        {loadError && <section className="setup-banner" role="alert"><Database aria-hidden="true" /><div><strong>{databaseSetupRequired ? 'Database setup required' : 'Sync paused'}</strong><p>{databaseSetupRequired ? 'Run the included traceable-ledger migration before adding or importing detailed entries.' : `${loadError} Your locally saved changes are safe and will retry automatically.`}</p>{databaseSetupRequired && <code>supabase/migrations/20260816030000_traceable_ledger.sql</code>}</div></section>}
        {notice && <p className="notice" role="status">{notice}</p>}

        <section className="metric-grid" aria-label="Monthly summary">
          <article><span>Asset value</span><strong>{formatCurrency(assets)}</strong><small>Current snapshot</small></article>
          <article><span>Monthly income</span><strong>{formatCurrency(income)}</strong><small>{formatMonth(activePeriod)}</small></article>
          <article><span>Monthly expenses</span><strong>{formatCurrency(expenses)}</strong><small>{income ? `${Math.round((expenses / income) * 100)}% of income` : 'No income recorded'}</small></article>
          <article><span>Invested</span><strong>{formatCurrency(investments)}</strong><small>{formatMonth(activePeriod)}</small></article>
        </section>

        <section className="dashboard-grid">
          <article className="panel trend-panel">
            <div className="panel-heading category-chart-heading"><div><p className="eyebrow">Category history</p><h2>{activeChartCategory || 'Choose a category'}</h2><p>{categoryTrend.length ? `${categoryTrend.length} monthly values · ${formatMonth(categoryTrend[0].period)}–${formatMonth(categoryTrend.at(-1)!.period)}` : 'No monthly values yet'}</p></div>{categoryTrend.length > 1 && <span className={`trend-badge ${categoryChange < 0 ? 'negative' : ''}`}>{categoryChange < 0 ? <TrendDown aria-hidden="true" /> : <TrendUp aria-hidden="true" />}{formatCurrency(categoryChange)}</span>}</div>
            <div className="chart-controls">
              <label><span>Record type</span><select aria-label="Chart record type" value={chartType} onChange={(event) => { setChartType(event.target.value as CategoryType); setChartCategory('') }}>{(Object.keys(categoryMeta) as CategoryType[]).map((key) => <option key={key} value={key}>{categoryMeta[key].label}</option>)}</select></label>
              <label><span>Category</span><select aria-label="Chart category" value={activeChartCategory} onChange={(event) => setChartCategory(event.target.value)}>{chartCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label>
            </div>
            {loading ? <div className="loading-state"><SpinnerGap className="spin" aria-hidden="true" />Loading records…</div> : <TrendChart points={categoryTrend} label={activeChartCategory} />}
          </article>

          <article className="panel add-panel" id="records"><div className="panel-heading"><div><p className="eyebrow">Traceable ledger</p><h2>Add a detailed entry</h2></div><Plus aria-hidden="true" /></div><form onSubmit={handleSave}>
            <label><span>Record type</span><select value={type} onChange={(event) => { setType(event.target.value as CategoryType); setCategoryName('') }}>{(Object.keys(categoryMeta) as CategoryType[]).map((key) => <option key={key} value={key}>{categoryMeta[key].label}</option>)}</select></label>
            <label><span>Category</span><input list="category-list" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Choose or create a category" required /><datalist id="category-list">{filteredCategories.map((category) => <option key={category.id} value={category.name} />)}</datalist></label>
            <label><span>Description</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What makes up this amount?" maxLength={200} required /></label>
            <div className="form-row"><label><span>Date</span><input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required /></label><label><span>Amount (MYR)</span><input type="number" inputMode="decimal" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required /></label></div>
            <button className="primary-button" type="submit" disabled={saving || !!loadError}>{saving ? <SpinnerGap className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}Save detailed entry</button>
          </form></article>
        </section>

        <section className="panel recent-panel" id="ledger">
          <div className="ledger-heading">
            <div><p className="eyebrow">Audit trail</p><h2>Traceable entries</h2><p>{filteredEntries.length.toLocaleString()} of {entries.length.toLocaleString()} entries</p></div>
            <div className="ledger-filters">
              <label><span className="sr-only">Filter by month</span><select value={ledgerMonth} onChange={(event) => { setLedgerMonth(event.target.value); setVisibleEntries(50) }}><option value="">All months</option>{ledgerMonths.map((month) => <option key={month} value={month}>{formatMonth(`${month}-01`)}</option>)}</select></label>
              <label className="search-field"><MagnifyingGlass aria-hidden="true" /><span className="sr-only">Search ledger</span><input type="search" value={ledgerSearch} onChange={(event) => { setLedgerSearch(event.target.value); setVisibleEntries(50) }} placeholder="Search entry or source" /></label>
            </div>
          </div>
          {entries.length === 0 ? <div className="empty-state"><Receipt aria-hidden="true" /><h3>No detailed entries yet</h3><p>Import the detailed history or add an entry to start the audit trail.</p></div> : filteredEntries.length === 0 ? <div className="empty-state"><MagnifyingGlass aria-hidden="true" /><h3>No matching entries</h3><p>Try another month or search term.</p></div> : <>
            <div className="record-list ledger-list">{filteredEntries.slice(0, visibleEntries).map((entry) => { const meta = categoryMeta[entry.financial_categories?.category_type ?? 'expense']; const Icon = meta.icon; const source = entry.source_type === 'google_sheets' ? `${entry.source_sheet} · ${entry.source_cell}` : 'Manual entry'; return <div className="record-row ledger-row" key={entry.id}><span className={`record-icon ${entry.financial_categories?.category_type}`}><Icon aria-hidden="true" /></span><span className="record-name"><strong>{entry.description}</strong><small>{entry.financial_categories?.name} · {formatEntryDate(entry.entry_date)}</small>{entry.source_formula ? <details className="source-detail"><summary>{source}</summary><code>{entry.source_formula}</code></details> : <small className="entry-source">{source}</small>}</span><strong className="record-amount">{formatCurrency(Number(entry.amount))}</strong></div>})}</div>
            {visibleEntries < filteredEntries.length && <button className="load-more" type="button" onClick={() => setVisibleEntries((count) => count + 50)}>Show 50 more</button>}
          </>}
        </section>
      </main>
    </div>
  )
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setLoading(false) })
    return () => data.subscription.unsubscribe()
  }, [])

  if (loading) return <main className="boot-screen"><span className="brand-mark" aria-hidden="true">Δ</span><SpinnerGap className="spin" aria-label="Loading WorthDelta" /></main>
  return session ? <Dashboard session={session} /> : <HubRedirect />
}

export default App
