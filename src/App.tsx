import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  CheckCircle,
  ChartLineUp,
  CloudArrowUp,
  Database,
  GearSix,
  MagnifyingGlass,
  Plus,
  Receipt,
  SignOut,
  SpinnerGap,
  TrendDown,
  TrendUp,
  Wallet,
  WifiSlash,
  X,
} from '@phosphor-icons/react'
import {
  getOfflineSnapshot,
  getPendingChangeCount,
  isNetworkError,
  queueCategory,
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
  investment: { label: 'Investments', icon: ChartLineUp },
  expense: { label: 'Expenses', icon: TrendDown },
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

const getCurrentMonthPeriod = () => {
  const today = new Date()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  return `${today.getFullYear()}-${month}-01`
}

const HUB_URL = 'https://kencode404.github.io/K-Super-Hub/'
const isLocalPreview = ['localhost', '127.0.0.1'].includes(window.location.hostname)
type SyncStatus = 'offline' | 'syncing' | 'pending' | 'synced'
type DashboardView = 'overview' | 'records' | 'settings'

const dashboardViewFromHash = (): DashboardView => {
  if (window.location.hash === '#records') return 'records'
  if (window.location.hash === '#settings') return 'settings'
  return 'overview'
}

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

interface CategoryBreakdown {
  id: string
  name: string
  amount: number
  percentage: number
  color: string
}

const chartColors = ['#228b22', '#2f6e9e', '#c46a3a', '#8064a2', '#c24d57', '#b08720', '#41827a', '#667085']
const monthOptions = Array.from({ length: 12 }, (_, index) => {
  const value = String(index + 1).padStart(2, '0')
  return {
    value,
    label: new Intl.DateTimeFormat('en-MY', { month: 'long' }).format(new Date(`2026-${value}-02T00:00:00`)),
  }
})

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
    if (isLocalPreview) return
    const destination = new URL(HUB_URL)
    destination.searchParams.set(
      'next',
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    )
    window.location.replace(destination.href)
  }, [])

  if (isLocalPreview) return <LocalAuth />

  return (
    <main className="boot-screen">
      <span className="brand-mark app-icon-mark" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}worthdelta-icon.png`} alt="" /></span>
      <SpinnerGap className="spin" aria-label="Opening K-Super Hub" />
    </main>
  )
}

function LocalAuth() {
  const [signingIn, setSigningIn] = useState(false)
  const [authError, setAuthError] = useState('')

  async function handleGoogleSignIn() {
    setSigningIn(true)
    setAuthError('')

    const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL}`
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    })

    if (error) {
      setAuthError(messageFrom(error))
      setSigningIn(false)
    }
  }

  return (
    <main className="local-auth-layout">
      <section className="local-auth-card" aria-labelledby="local-auth-title">
        <span className="brand-mark app-icon-mark local-auth-icon" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}worthdelta-icon.png`} alt="" /></span>
        <p className="eyebrow">Local preview</p>
        <h1 id="local-auth-title">Open your WorthDelta data</h1>
        <p>Sign in with the same Google account you use on K-Super Hub. This development login returns only to this local test site.</p>
        {authError && <p className="form-alert error" role="alert">{authError}</p>}
        <button className="google-button local-google-button" type="button" onClick={() => void handleGoogleSignIn()} disabled={signingIn}>
          {signingIn ? <SpinnerGap className="spin" aria-hidden="true" /> : null}
          {signingIn ? 'Opening Google…' : 'Continue with Google'}
        </button>
        <small>Production login remains connected to K-Super Hub.</small>
      </section>
    </main>
  )
}

function DonutChart({ label, total, categories }: { label: string; total: number; categories: CategoryBreakdown[] }) {
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const active = categories.find((category) => category.id === activeCategory)
  let offset = 0

  return (
    <div className="donut-wrap">
      <svg className="donut-chart" viewBox="0 0 120 120" role="img" aria-label={`${label} category proportions. Total ${formatCurrency(total)}.`}>
        <circle className="donut-track" cx="60" cy="60" r="43" pathLength="100" />
        {categories.filter((category) => category.amount > 0).map((category) => {
          const dashOffset = -offset
          offset += category.percentage
          return <circle
            className="donut-slice"
            key={category.id}
            cx="60"
            cy="60"
            r="43"
            pathLength="100"
            fill="none"
            stroke={category.color}
            strokeDasharray={`${category.percentage} ${100 - category.percentage}`}
            strokeDashoffset={dashOffset}
            role="button"
            tabIndex={0}
            aria-label={`${category.name}: ${formatCurrency(category.amount)}, ${Math.round(category.percentage)} percent`}
            onMouseEnter={() => setActiveCategory(category.id)}
            onMouseLeave={() => setActiveCategory(null)}
            onFocus={() => setActiveCategory(category.id)}
            onBlur={() => setActiveCategory(null)}
            onPointerDown={(event) => {
              if (event.pointerType !== 'mouse') {
                setActiveCategory((current) => current === category.id ? null : category.id)
              }
            }}
          ><title>{category.name}: {formatCurrency(category.amount)} ({Math.round(category.percentage)}%)</title></circle>
        })}
      </svg>
      <div className="donut-center" aria-hidden="true">
        <small>{active?.name ?? 'Total'}</small>
        <strong>{formatCurrency(active?.amount ?? total)}</strong>
        {active && <span>{Math.round(active.percentage)}%</span>}
      </div>
    </div>
  )
}

function RecordSectionCard({
  type,
  period,
  total,
  categories,
}: {
  type: CategoryType
  period: string
  total: number
  categories: CategoryBreakdown[]
}) {
  const meta = categoryMeta[type]
  const Icon = meta.icon

  return (
    <article className={`record-section-card ${type}`}>
      <header className="record-section-heading">
        <span className={`record-section-icon ${type}`}><Icon weight="duotone" aria-hidden="true" /></span>
        <div><p>{meta.label}</p><strong>{formatCurrency(total)}</strong><small>{formatMonth(period)}</small></div>
      </header>
      <div className="record-section-body">
        <DonutChart label={meta.label} total={total} categories={categories} />
        {categories.length === 0 ? <div className="category-empty"><p>No {meta.label.toLocaleLowerCase('en')} categories yet.</p><a href="#settings">Add categories in Settings</a></div> : <div className="category-breakdown-list">
          {categories.map((category) => <div className="category-breakdown-row" key={category.id}>
            <span className="category-color" style={{ background: category.color }} aria-hidden="true" />
            <span className="category-breakdown-name"><strong>{category.name}</strong><span className="category-progress" aria-hidden="true"><i style={{ width: `${category.percentage}%`, background: category.color }} /></span></span>
            <span className="category-breakdown-value"><strong>{formatCurrency(category.amount)}</strong><small>{category.percentage.toFixed(category.percentage > 0 && category.percentage < 1 ? 1 : 0)}%</small></span>
          </div>)}
        </div>}
      </div>
    </article>
  )
}

function AnnualChart({ years }: { years: AnnualSummary[] }) {
  const [activeYear, setActiveYear] = useState<number | null>(null)

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
    { key: 'income' as const, label: 'Income', color: '#218a70' },
    { key: 'expenses' as const, label: 'Expenses', color: '#d85f63' },
    { key: 'investments' as const, label: 'Invested', color: '#477fc6' },
  ]
  const activeSummary = years.find((year) => year.year === activeYear)
  const activeIndex = activeSummary ? years.indexOf(activeSummary) : -1
  const activeCenter = activeIndex >= 0 ? padding.left + groupWidth * activeIndex + groupWidth / 2 : 0
  const tooltipWidth = 236
  const tooltipX = Math.max(padding.left, Math.min(activeCenter - tooltipWidth / 2, width - padding.right - tooltipWidth))
  const yearLabel = (year: AnnualSummary) => `${year.year}: Income ${formatCurrency(year.income)}, expenses ${formatCurrency(year.expenses)}, invested ${formatCurrency(year.investments)}, net worth ${formatCurrency(year.netWorth)}`

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
        <path d={worthPath} fill="none" stroke="#172e57" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        {worthPoints.map((point) => <circle key={point.year.year} cx={point.x} cy={point.y} r="7" fill="#fffefa" stroke="#172e57" strokeWidth="4"><title>{point.year.year} net worth: {formatCurrency(point.year.netWorth)}</title></circle>)}
        {activeSummary && <g className="annual-tooltip" pointerEvents="none">
          <rect className="annual-tooltip-shadow" x={tooltipX + 5} y="15" width={tooltipWidth} height="126" rx="14" />
          <rect className="annual-tooltip-card" x={tooltipX} y="10" width={tooltipWidth} height="126" rx="14" />
          <text className="annual-tooltip-year" x={tooltipX + 16} y="34">{activeSummary.year}</text>
          <text x={tooltipX + 16} y="57">Income <tspan x={tooltipX + tooltipWidth - 16} textAnchor="end">{formatCurrency(activeSummary.income)}</tspan></text>
          <text x={tooltipX + 16} y="78">Expenses <tspan x={tooltipX + tooltipWidth - 16} textAnchor="end">{formatCurrency(activeSummary.expenses)}</tspan></text>
          <text x={tooltipX + 16} y="99">Invested <tspan x={tooltipX + tooltipWidth - 16} textAnchor="end">{formatCurrency(activeSummary.investments)}</tspan></text>
          <text className="annual-tooltip-worth" x={tooltipX + 16} y="122">Net worth <tspan x={tooltipX + tooltipWidth - 16} textAnchor="end">{formatCurrency(activeSummary.netWorth)}</tspan></text>
        </g>}
        {years.map((year, yearIndex) => {
          const x = padding.left + groupWidth * yearIndex
          return <g
            key={`hit-${year.year}`}
            className="annual-year-hit"
            role="button"
            tabIndex={0}
            aria-label={yearLabel(year)}
            onMouseEnter={() => setActiveYear(year.year)}
            onMouseLeave={() => setActiveYear(null)}
            onFocus={() => setActiveYear(year.year)}
            onBlur={() => setActiveYear(null)}
            onPointerDown={(event) => {
              if (event.pointerType !== 'mouse') setActiveYear((current) => current === year.year ? null : year.year)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setActiveYear((current) => current === year.year ? null : year.year)
              }
            }}
          ><rect x={x} y={padding.top} width={groupWidth} height={plotHeight + 42} fill="transparent" /></g>
        })}
      </svg>
      <p className="chart-interaction-hint">Hover, tap, or focus a year to see its values.</p>
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
  const [view, setView] = useState<DashboardView>(dashboardViewFromHash)
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
  const [recordPeriod, setRecordPeriod] = useState(getCurrentMonthPeriod)
  const [entryDialogOpen, setEntryDialogOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [categorySaving, setCategorySaving] = useState<CategoryType | null>(null)
  const [newCategoryNames, setNewCategoryNames] = useState<Record<CategoryType, string>>({
    asset: '',
    income: '',
    investment: '',
    expense: '',
  })
  const entryDialogRef = useRef<HTMLDialogElement>(null)
  const floatingAddButtonRef = useRef<HTMLButtonElement>(null)
  const firstTypeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const handleHashChange = () => {
      setView(dashboardViewFromHash())
      setAddMenuOpen(false)
      window.scrollTo({ top: 0, behavior: 'auto' })
    }
    if (!['#overview', '#records', '#settings'].includes(window.location.hash)) {
      window.history.replaceState(null, '', '#overview')
    }
    handleHashChange()
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    const dialog = entryDialogRef.current
    if (!dialog) return
    if (entryDialogOpen && !dialog.open) dialog.showModal()
    if (!entryDialogOpen && dialog.open) dialog.close()
  }, [entryDialogOpen])

  useEffect(() => {
    if (!addMenuOpen) return
    firstTypeButtonRef.current?.focus()
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAddMenuOpen(false)
      floatingAddButtonRef.current?.focus()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [addMenuOpen])

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
  const recordPeriods = useMemo(
    () => [...new Set(records.map((record) => record.period))].sort().reverse(),
    [records],
  )
  const summaryPeriod = recordPeriod || getCurrentMonthPeriod()
  const selectedRecordYear = summaryPeriod.slice(0, 4)
  const selectedRecordMonth = summaryPeriod.slice(5, 7)
  const recordYears = [...new Set([
    ...recordPeriods.map((period) => period.slice(0, 4)),
    selectedRecordYear,
  ])].sort().reverse()
  const recordSections = useMemo(() => {
    const types = Object.keys(categoryMeta) as CategoryType[]
    return types.map((sectionType) => {
      const sectionCategories = categories
        .filter((category) => category.category_type === sectionType)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      const sectionRecords = records.filter((record) =>
        record.period === summaryPeriod &&
        record.financial_categories?.category_type === sectionType,
      )
      const amountByName = new Map(
        sectionRecords.map((record) => [record.financial_categories?.name.toLocaleLowerCase('en') ?? '', Number(record.amount)]),
      )
      const total = sectionRecords.reduce((sum, record) => sum + Number(record.amount), 0)
      const breakdown: CategoryBreakdown[] = sectionCategories
        .map((category, index) => {
          const amount = amountByName.get(category.name.toLocaleLowerCase('en')) ?? 0
          return {
            id: category.id,
            name: category.name,
            amount,
            percentage: total > 0 ? (amount / total) * 100 : 0,
            color: chartColors[index % chartColors.length],
          }
        })
        .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
      return { type: sectionType, total, categories: breakdown }
    })
  }, [categories, records, summaryPeriod])

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
      setEntryDialogOpen(false)

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

  function openEntryForType(nextType: CategoryType) {
    setType(nextType)
    setCategoryName(categories.find((category) => category.category_type === nextType)?.name ?? '')
    setAddMenuOpen(false)
    setEntryDialogOpen(true)
  }

  async function handleAddCategory(event: React.FormEvent, categoryType: CategoryType) {
    event.preventDefault()
    const categoryNameValue = newCategoryNames[categoryType].trim()
    if (!categoryNameValue) return
    if (categories.some((category) =>
      category.category_type === categoryType &&
      category.name.toLocaleLowerCase('en') === categoryNameValue.toLocaleLowerCase('en'),
    )) {
      setNotice(`${categoryNameValue} already exists under ${categoryMeta[categoryType].label}.`)
      return
    }

    setCategorySaving(categoryType)
    setNotice('')
    try {
      const sortOrder = Math.max(
        0,
        ...categories
          .filter((category) => category.category_type === categoryType)
          .map((category) => category.sort_order),
      ) + 1
      const queued = await queueCategory({
        userId: session.user.id,
        categoryType,
        categoryName: categoryNameValue,
        categorySortOrder: sortOrder,
      })
      showSnapshot(queued.snapshot)
      setPendingCount(queued.pendingCount)
      setNewCategoryNames((current) => ({ ...current, [categoryType]: '' }))

      if (!navigator.onLine) {
        setSyncStatus('offline')
        setNotice('Category saved on this device. It will sync automatically when you reconnect.')
        return
      }

      setSyncStatus('syncing')
      await syncPendingChanges(session.user.id)
      const remote = await refreshRemoteSnapshot(session.user.id)
      showSnapshot(remote.snapshot)
      setPendingCount(remote.pendingCount)
      setSyncStatus(remote.pendingCount > 0 ? 'pending' : 'synced')
      setLoadError('')
      setNotice(`${categoryNameValue} added to ${categoryMeta[categoryType].label}.`)
    } catch (error) {
      const queued = await getPendingChangeCount(session.user.id).catch(() => 0)
      setPendingCount(queued)
      setSyncStatus(navigator.onLine ? 'pending' : 'offline')
      setNotice(queued > 0 ? 'Category saved on this device. Sync will retry automatically.' : messageFrom(error))
      if (!isNetworkError(error) && queued === 0) setLoadError(messageFrom(error))
    } finally {
      setCategorySaving(null)
    }
  }

  const filteredCategories = categories.filter((category) => category.category_type === type)
  const EntryTypeIcon = categoryMeta[type].icon
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
  const viewCopy = view === 'overview'
    ? { title: 'Personal finance dashboard', lead: 'Every year, in view.', detail: `Latest asset snapshot: ${formatMonth(activePeriod)}` }
    : view === 'records'
      ? { title: 'Your financial records', lead: 'Every category, in view.', detail: `${entries.length.toLocaleString()} entries across ${categories.length.toLocaleString()} categories` }
      : { title: 'Category settings', lead: 'Make WorthDelta yours.', detail: 'Organise categories under the four financial sections' }

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <a className="brand brand-light" href="#overview" aria-label="WorthDelta overview"><span className="brand-mark app-icon-mark" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}worthdelta-icon.png`} alt="" /></span><span>WorthDelta</span></a>
        <nav aria-label="Dashboard"><a className={`nav-item ${view === 'overview' ? 'active' : ''}`} href="#overview"><ChartLineUp weight="duotone" aria-hidden="true" />Overview</a><a className={`nav-item ${view === 'records' ? 'active' : ''}`} href="#records"><Receipt weight="duotone" aria-hidden="true" />Records</a><a className={`nav-item ${view === 'settings' ? 'active' : ''}`} href="#settings"><GearSix weight="duotone" aria-hidden="true" />Settings</a></nav>
        <div className="sidebar-user"><span className="avatar">{(session.user.email?.[0] ?? 'W').toUpperCase()}</span><span><strong>{session.user.user_metadata.full_name ?? 'WorthDelta user'}</strong><small>{session.user.email}</small></span><button type="button" onClick={() => void supabase.auth.signOut()} aria-label="Sign out"><SignOut aria-hidden="true" /></button></div>
      </aside>

      <main className="dashboard-main">
        <div className="mobile-tabs" aria-label="Dashboard views"><a className={view === 'overview' ? 'active' : ''} href="#overview">Overview</a><a className={view === 'records' ? 'active' : ''} href="#records">Records</a><a className={view === 'settings' ? 'active' : ''} href="#settings">Settings</a></div>
        <header className="dashboard-header"><div><h1>{viewCopy.title}</h1><p className="header-subtitle"><strong>{viewCopy.lead}</strong><span aria-hidden="true">·</span><span>{viewCopy.detail}</span></p></div><div className="header-actions"><span className={`sync-status ${syncStatus}`} role="status" aria-live="polite"><SyncIcon className={syncStatus === 'syncing' ? 'spin' : ''} aria-hidden="true" />{syncLabel}</span></div></header>

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
        </> : view === 'records' ? <>

        <section className="panel record-toolbar" id="records" aria-label="Record summary controls">
          <div className="record-period-controls">
            <label><span>Month</span><select value={selectedRecordMonth} onChange={(event) => setRecordPeriod(`${selectedRecordYear}-${event.target.value}-01`)}>{monthOptions.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}</select></label>
            <label><span>Year</span><select value={selectedRecordYear} onChange={(event) => setRecordPeriod(`${event.target.value}-${selectedRecordMonth}-01`)}>{recordYears.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
          </div>
        </section>

        {loading ? <div className="loading-state"><SpinnerGap className="spin" aria-hidden="true" />Loading category sections…</div> : <section className="record-section-grid" aria-label={`Category summaries for ${formatMonth(summaryPeriod)}`}>
          {recordSections.map((section) => <RecordSectionCard key={section.type} type={section.type} period={summaryPeriod} total={section.total} categories={section.categories} />)}
        </section>}

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
        </> : <>
        <section className="panel settings-intro">
          <div><p className="eyebrow">Category organiser</p><h2>Set up your four sections</h2><p>Add the category names you want to use when recording money. New categories are available in the Add entry form immediately, even while offline.</p></div>
          <a className="secondary-button" href="#records"><Receipt aria-hidden="true" />Back to records</a>
        </section>

        <section className="category-settings-grid" aria-label="Financial category settings">
          {(Object.keys(categoryMeta) as CategoryType[]).map((categoryType) => {
            const meta = categoryMeta[categoryType]
            const Icon = meta.icon
            const sectionCategories = categories.filter((category) => category.category_type === categoryType)
            return <article className={`category-settings-card ${categoryType}`} key={categoryType}>
              <header><span className={`record-section-icon ${categoryType}`}><Icon weight="duotone" aria-hidden="true" /></span><div><h2>{meta.label}</h2><p>{sectionCategories.length} {sectionCategories.length === 1 ? 'category' : 'categories'}</p></div></header>
              <form className="category-add-form" onSubmit={(event) => void handleAddCategory(event, categoryType)}>
                <label><span className="sr-only">New {meta.label.toLocaleLowerCase('en')} category</span><input value={newCategoryNames[categoryType]} onChange={(event) => setNewCategoryNames((current) => ({ ...current, [categoryType]: event.target.value }))} placeholder={`New ${meta.label.toLocaleLowerCase('en')} category`} maxLength={80} required /></label>
                <button type="submit" disabled={categorySaving !== null}>{categorySaving === categoryType ? <SpinnerGap className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}Add</button>
              </form>
              {sectionCategories.length === 0 ? <p className="settings-empty">No categories here yet.</p> : <ul className="category-chip-list">{sectionCategories.map((category) => <li key={category.id}><span aria-hidden="true" />{category.name}</li>)}</ul>}
            </article>
          })}
        </section>
        </>}

        {view === 'records' && <>
          {addMenuOpen && <div className="floating-menu-backdrop" aria-hidden="true" onPointerDown={() => setAddMenuOpen(false)} />}
          <div className="floating-add-group">
            {addMenuOpen && <div className="floating-type-menu" id="entry-type-menu" role="menu" aria-label="Choose entry section">
              {(Object.keys(categoryMeta) as CategoryType[]).map((categoryType, index) => {
                const meta = categoryMeta[categoryType]
                const Icon = meta.icon
                return <button className={`floating-type-button ${categoryType}`} ref={index === 0 ? firstTypeButtonRef : undefined} key={categoryType} type="button" role="menuitem" onClick={() => openEntryForType(categoryType)}><Icon weight="duotone" aria-hidden="true" /><span>{meta.label}</span></button>
              })}
            </div>}
            <button className={`floating-add-button ${addMenuOpen ? 'open' : ''}`} ref={floatingAddButtonRef} type="button" aria-label={addMenuOpen ? 'Close entry section menu' : 'Add entry'} aria-expanded={addMenuOpen} aria-controls="entry-type-menu" title={addMenuOpen ? 'Close' : 'Add entry'} onClick={() => setAddMenuOpen((open) => !open)}>{addMenuOpen ? <X weight="bold" aria-hidden="true" /> : <Plus weight="bold" aria-hidden="true" />}</button>
          </div>
        </>}

        <dialog className="entry-dialog" ref={entryDialogRef} aria-labelledby="entry-dialog-title" onClose={() => setEntryDialogOpen(false)} onCancel={() => setEntryDialogOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setEntryDialogOpen(false) }}>
          <div className="entry-dialog-card">
            <header className="entry-dialog-heading"><div><p className="eyebrow">Traceable ledger</p><h2 id="entry-dialog-title">Add a new entry</h2><p>Every entry updates its monthly category total.</p></div><button type="button" onClick={() => setEntryDialogOpen(false)} aria-label="Close add entry form"><X aria-hidden="true" /></button></header>
            <form onSubmit={handleSave}>
              <div className={`entry-type-badge ${type}`}><EntryTypeIcon weight="duotone" aria-hidden="true" /><span>{categoryMeta[type].label}</span></div>
              <label><span>Category</span><select value={categoryName} onChange={(event) => setCategoryName(event.target.value)} required><option value="" disabled>{filteredCategories.length ? 'Choose a category' : 'Add a category in Settings first'}</option>{filteredCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label>
              {filteredCategories.length === 0 && <a className="dialog-settings-link" href="#settings" onClick={() => setEntryDialogOpen(false)}><GearSix aria-hidden="true" />Open category settings</a>}
              <label><span>Description</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What makes up this amount?" maxLength={200} required /></label>
              <div className="form-row"><label><span>Date</span><input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required /></label><label><span>Amount (MYR)</span><input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required /></label></div>
              <div className="entry-dialog-actions"><button className="dialog-cancel-button" type="button" onClick={() => setEntryDialogOpen(false)}>Cancel</button><button className="primary-action-button" type="submit" disabled={saving || !!loadError || filteredCategories.length === 0}>{saving ? <SpinnerGap className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}Save entry</button></div>
            </form>
          </div>
        </dialog>
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
