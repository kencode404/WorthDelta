import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  CheckCircle,
  ChartLineUp,
  CloudArrowUp,
  Database,
  FileArrowUp,
  MagnifyingGlass,
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
type DashboardView = 'overview' | 'records'

interface AnnualSummary {
  year: number
  income: number
  expenses: number
  investments: number
  netWorth: number
  netWorthChange: number
  monthsTracked: number
  savingsRate: number
  assetTrend: Array<{ period: string; value: number }>
}

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

function AnnualChart({ years }: { years: AnnualSummary[] }) {
  if (years.length === 0) return <div className="chart-empty">Your annual progress will appear once records are added.</div>

  const width = 1080
  const height = 390
  const padding = { top: 28, right: 72, bottom: 58, left: 72 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const barMax = Math.max(...years.flatMap((year) => [year.income, year.expenses, year.investments]), 1)
  const worthMax = Math.max(...years.map((year) => year.netWorth), 1)
  const groupWidth = plotWidth / years.length
  const barWidth = Math.min(26, groupWidth / 5)
  const yBar = (value: number) => padding.top + plotHeight - (value / barMax) * plotHeight
  const yWorth = (value: number) => padding.top + plotHeight - (value / worthMax) * plotHeight
  const worthPoints = years.map((year, index) => ({
    x: padding.left + groupWidth * index + groupWidth / 2,
    y: yWorth(year.netWorth),
    year,
  }))
  const worthPath = worthPoints.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
  const gridLines = [0, .25, .5, .75, 1]
  const barSeries = [
    { key: 'income' as const, label: 'Income', color: '#4e9b6c' },
    { key: 'expenses' as const, label: 'Expenses', color: '#d56c6c' },
    { key: 'investments' as const, label: 'Invested', color: '#5d8fc2' },
  ]

  return (
    <div className="annual-chart-wrap">
      <div className="chart-legend" aria-hidden="true">
        {barSeries.map((series) => <span key={series.key}><i style={{ background: series.color }} />{series.label}</span>)}
        <span><i className="legend-line" />Net worth</span>
      </div>
      <svg className="annual-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Annual income, expenses, investments, and net worth from ${years[0].year} to ${years.at(-1)!.year}`}>
        {gridLines.map((line) => {
          const y = padding.top + plotHeight - line * plotHeight
          return <g key={line}><line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#dfe7e2" strokeWidth="1" /><text x={padding.left - 12} y={y + 4} textAnchor="end">{Math.round((barMax * line) / 1000)}k</text><text x={width - padding.right + 12} y={y + 4}>{Math.round((worthMax * line) / 1000)}k</text></g>
        })}
        {years.map((year, yearIndex) => {
          const center = padding.left + groupWidth * yearIndex + groupWidth / 2
          return <g key={year.year}>{barSeries.map((series, seriesIndex) => {
            const value = year[series.key]
            const x = center + (seriesIndex - 1) * (barWidth + 3) - barWidth / 2
            const y = yBar(value)
            return <rect key={series.key} x={x} y={y} width={barWidth} height={padding.top + plotHeight - y} rx="3" fill={series.color}><title>{year.year} {series.label}: {formatCurrency(value)}</title></rect>
          })}<text x={center} y={height - 22} textAnchor="middle" className="annual-year-label">{year.year}</text></g>
        })}
        <path d={worthPath} fill="none" stroke="#20352c" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {worthPoints.map((point) => <circle key={point.year.year} cx={point.x} cy={point.y} r="6" fill="#fff" stroke="#20352c" strokeWidth="4"><title>{point.year.year} net worth: {formatCurrency(point.year.netWorth)}</title></circle>)}
      </svg>
    </div>
  )
}

function YearSparkline({ points }: { points: AnnualSummary['assetTrend'] }) {
  if (points.length < 2) return <div className="sparkline-empty" />
  const width = 280
  const height = 54
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spread = max - min || 1
  const path = points.map((point, index) => {
    const x = (index / (points.length - 1)) * width
    const y = height - 4 - ((point.value - min) / spread) * (height - 8)
    return `${index ? 'L' : 'M'} ${x} ${y}`
  }).join(' ')
  return <svg className="year-sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Monthly net worth from ${formatMonth(points[0].period)} to ${formatMonth(points.at(-1)!.period)}`}><path d={path} fill="none" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function Dashboard({ session }: { session: Session }) {
  const [view, setView] = useState<DashboardView>(() => window.location.hash === '#records' ? 'records' : 'overview')
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

  useEffect(() => {
    const handleHashChange = () => setView(window.location.hash === '#records' ? 'records' : 'overview')
    if (window.location.hash !== '#overview' && window.location.hash !== '#records') {
      window.history.replaceState(null, '', '#overview')
    }
    handleHashChange()
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

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

  const annualSummaries = useMemo<AnnualSummary[]>(() => {
    const yearMap = new Map<number, {
      income: number
      expenses: number
      investments: number
      assets: Map<string, number>
    }>()

    records.forEach((record) => {
      const year = Number(record.period.slice(0, 4))
      if (!Number.isFinite(year)) return
      const summary = yearMap.get(year) ?? { income: 0, expenses: 0, investments: 0, assets: new Map<string, number>() }
      const recordType = record.financial_categories?.category_type
      const value = Number(record.amount)
      if (recordType === 'income') summary.income += value
      if (recordType === 'expense') summary.expenses += value
      if (recordType === 'investment') summary.investments += value
      if (recordType === 'asset') summary.assets.set(record.period, (summary.assets.get(record.period) ?? 0) + value)
      yearMap.set(year, summary)
    })

    let previousNetWorth: number | undefined
    return [...yearMap.entries()].sort(([a], [b]) => a - b).map(([year, summary]) => {
      const yearlyAssetTrend = [...summary.assets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, value]) => ({ period, value }))
      const netWorth = yearlyAssetTrend.at(-1)?.value ?? 0
      const openingWorth = previousNetWorth ?? yearlyAssetTrend[0]?.value ?? 0
      const result: AnnualSummary = {
        year,
        income: summary.income,
        expenses: summary.expenses,
        investments: summary.investments,
        netWorth,
        netWorthChange: netWorth - openingWorth,
        monthsTracked: yearlyAssetTrend.length,
        savingsRate: summary.income ? ((summary.income - summary.expenses) / summary.income) * 100 : 0,
        assetTrend: yearlyAssetTrend,
      }
      previousNetWorth = netWorth
      return result
    })
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
        <a className="brand brand-light" href="#overview" aria-label="WorthDelta overview"><span className="brand-mark app-icon-mark" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}worthdelta-icon.png`} alt="" /></span><span>WorthDelta</span></a>
        <nav aria-label="Dashboard"><a className={`nav-item ${view === 'overview' ? 'active' : ''}`} href="#overview"><ChartLineUp aria-hidden="true" />Overview</a><a className={`nav-item ${view === 'records' ? 'active' : ''}`} href="#records"><Receipt aria-hidden="true" />Records</a></nav>
        <div className="sidebar-user"><span className="avatar">{(session.user.email?.[0] ?? 'W').toUpperCase()}</span><span><strong>{session.user.user_metadata.full_name ?? 'WorthDelta user'}</strong><small>{session.user.email}</small></span><button type="button" onClick={() => void supabase.auth.signOut()} aria-label="Sign out"><SignOut aria-hidden="true" /></button></div>
      </aside>

      <main className="dashboard-main">
        <div className="mobile-tabs" aria-label="Dashboard views"><a className={view === 'overview' ? 'active' : ''} href="#overview">Overview</a><a className={view === 'records' ? 'active' : ''} href="#records">Records</a></div>
        <header className="dashboard-header"><div><p className="eyebrow">{view === 'overview' ? 'Personal finance dashboard' : 'Traceable finance history'}</p><h1>{view === 'overview' ? 'Every year, in view.' : 'Every amount, traceable.'}</h1><p>{view === 'overview' ? `Latest asset snapshot: ${formatMonth(activePeriod)}` : `${entries.length.toLocaleString()} detailed records across ${categories.length.toLocaleString()} categories`}</p></div><div className="header-actions"><span className={`sync-status ${syncStatus}`} role="status" aria-live="polite"><SyncIcon className={syncStatus === 'syncing' ? 'spin' : ''} aria-hidden="true" />{syncLabel}</span>{view === 'records' && <button className="outline-button" type="button" onClick={() => fileInput.current?.click()} disabled={saving}><FileArrowUp aria-hidden="true" />Import history</button>}<input ref={fileInput} className="sr-only" type="file" accept="application/json,.json" onChange={handleImport} /></div></header>

        {loadError && <section className="setup-banner" role="alert"><Database aria-hidden="true" /><div><strong>{databaseSetupRequired ? 'Database setup required' : 'Sync paused'}</strong><p>{databaseSetupRequired ? 'Run the included traceable-ledger migration before adding or importing detailed entries.' : `${loadError} Your locally saved changes are safe and will retry automatically.`}</p>{databaseSetupRequired && <code>supabase/migrations/20260816030000_traceable_ledger.sql</code>}</div></section>}
        {notice && <p className="notice" role="status">{notice}</p>}

        {view === 'overview' ? <>
        <section className="metric-grid" aria-label="Latest monthly summary">
          <article><span>Asset value</span><strong>{formatCurrency(assets)}</strong><small>Current snapshot</small></article>
          <article><span>Monthly income</span><strong>{formatCurrency(income)}</strong><small>{formatMonth(activePeriod)}</small></article>
          <article><span>Monthly expenses</span><strong>{formatCurrency(expenses)}</strong><small>{income ? `${Math.round((expenses / income) * 100)}% of income` : 'No income recorded'}</small></article>
          <article><span>Invested</span><strong>{formatCurrency(investments)}</strong><small>{formatMonth(activePeriod)}</small></article>
        </section>

        <section className="panel annual-panel">
          <div className="panel-heading annual-heading"><div><p className="eyebrow">Annual dashboard</p><h2>Your financial progress</h2><p>Income, spending, investing, and closing net worth by year.</p></div><span className="annual-range">{annualSummaries[0]?.year ?? '—'}–{annualSummaries.at(-1)?.year ?? '—'}</span></div>
          {loading ? <div className="loading-state"><SpinnerGap className="spin" aria-hidden="true" />Loading annual progress…</div> : <AnnualChart years={annualSummaries} />}
          {annualSummaries.length > 0 && <div className="annual-table-wrap"><table className="annual-summary-table"><caption className="sr-only">Annual financial totals</caption><thead><tr><th scope="col">Measure</th>{annualSummaries.map((year) => <th scope="col" key={year.year}>{year.year}</th>)}</tr></thead><tbody>
            <tr><th scope="row">Total income</th>{annualSummaries.map((year) => <td key={year.year}>{formatCurrency(year.income)}</td>)}</tr>
            <tr><th scope="row">Expenses</th>{annualSummaries.map((year) => <td key={year.year}>{formatCurrency(year.expenses)}</td>)}</tr>
            <tr><th scope="row">Investments</th>{annualSummaries.map((year) => <td key={year.year}>{formatCurrency(year.investments)}</td>)}</tr>
            <tr className="net-worth-row"><th scope="row">Net worth</th>{annualSummaries.map((year) => <td key={year.year}>{formatCurrency(year.netWorth)}</td>)}</tr>
          </tbody></table></div>}
        </section>

        <section className="year-progress-section" aria-labelledby="year-progress-title">
          <div className="section-heading"><div><p className="eyebrow">Year by year</p><h2 id="year-progress-title">Progress cards</h2></div><p>Closing net worth uses the latest asset month recorded in each year.</p></div>
          <div className="year-progress-grid">{annualSummaries.map((year) => <article className="year-card" key={year.year}>
            <div className="year-card-heading"><div><span>{year.year}</span><strong>{formatCurrency(year.netWorth)}</strong><small>Closing net worth</small></div><span className={`year-change ${year.netWorthChange < 0 ? 'negative' : ''}`}>{year.netWorthChange >= 0 ? '+' : ''}{formatCurrency(year.netWorthChange)}</span></div>
            <YearSparkline points={year.assetTrend} />
            <dl><div><dt>Income</dt><dd>{formatCurrency(year.income)}</dd></div><div><dt>Expenses</dt><dd>{formatCurrency(year.expenses)}</dd></div><div><dt>Invested</dt><dd>{formatCurrency(year.investments)}</dd></div><div><dt>Savings rate</dt><dd>{Math.round(year.savingsRate)}%</dd></div></dl>
            <div className="year-months"><span><strong>{year.monthsTracked}</strong> of 12 asset months</span><span>{Math.min(100, Math.round((year.monthsTracked / 12) * 100))}%</span></div><div className="year-progress-track"><span style={{ width: `${Math.min(100, (year.monthsTracked / 12) * 100)}%` }} /></div>
          </article>)}</div>
        </section>
        </> : <>

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
        </>}
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
