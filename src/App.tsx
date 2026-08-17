import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  CheckCircle,
  ChartLineUp,
  CloudArrowUp,
  Database,
  GearSix,
  List,
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
import type { CategoryType, ExpenseGroup, FinancialCategory, LedgerEntry, MonthlyRecord } from './types'
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

const formatPercentage = (value: number) =>
  value.toFixed(value > 0 && value < 1 ? 1 : 0)

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
  expenseGroupId: string | null
}

interface DonutGroupBreakdown {
  id: string
  name: string
  amount: number
  percentage: number
  color: string
}

const chartColors = ['#228b22', '#2f6e9e', '#c46a3a', '#8064a2', '#c24d57', '#b08720', '#41827a', '#667085']
const expenseGroupColors = ['#2f6e9e', '#d06b34', '#8064a2', '#687386']
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

function DonutChart({
  label,
  total,
  categories,
  groups = [],
}: {
  label: string
  total: number
  categories: CategoryBreakdown[]
  groups?: DonutGroupBreakdown[]
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const active = categories.find((category) => activeKey === category.id)
  const visibleCategories = categories.filter((category) => category.amount > 0)
  const hasGroupLegend = groups.length > 0
  const hasGroupSeparation = new Set(visibleCategories.map((category) => category.expenseGroupId ?? 'ungrouped')).size > 1
  const groupColors = new Map(groups.map((group) => [group.id, group.color]))
  let categoryOffset = 0
  const categorySegments = visibleCategories.map((category, index) => {
    const dashOffset = -categoryOffset
    const nextCategory = visibleCategories[(index + 1) % visibleCategories.length]
    const endsGroup = hasGroupSeparation && category.expenseGroupId !== nextCategory?.expenseGroupId
    const groupGap = endsGroup ? Math.min(1.2, category.percentage * .25) : 0
    const visiblePercentage = category.percentage - groupGap
    categoryOffset += category.percentage
    return { category, dashOffset, visiblePercentage }
  })

  return (
    <div className={`donut-wrap ${hasGroupLegend ? 'has-group-outlines' : ''}`}>
      <div className="donut-canvas">
        <svg className="donut-chart" viewBox="0 0 120 120" role="img" aria-label={`${label} category proportions${hasGroupLegend ? '. Main group percentages are listed below' : ''}. Total ${formatCurrency(total)}.`}>
          <circle className="donut-track" cx="60" cy="60" r="43" pathLength="100" />
          {hasGroupLegend && categorySegments.map(({ category, dashOffset, visiblePercentage }) => <circle
            className="donut-group-outline"
            key={`outline:${category.id}`}
            cx="60"
            cy="60"
            r="43"
            pathLength="100"
            stroke={groupColors.get(category.expenseGroupId ?? 'ungrouped') ?? '#687386'}
            strokeDasharray={`${visiblePercentage} ${100 - visiblePercentage}`}
            strokeDashoffset={dashOffset}
            aria-hidden="true"
          />)}
          {categorySegments.map(({ category, dashOffset, visiblePercentage }) => {
            const key = category.id
            return <circle
              className="donut-slice"
              key={category.id}
              cx="60"
              cy="60"
              r="43"
              pathLength="100"
              fill="none"
              stroke={category.color}
              strokeDasharray={`${visiblePercentage} ${100 - visiblePercentage}`}
              strokeDashoffset={dashOffset}
              role="button"
              tabIndex={0}
              aria-label={`${category.name}: ${formatCurrency(category.amount)}, ${Math.round(category.percentage)} percent`}
              onMouseEnter={() => setActiveKey(key)}
              onMouseLeave={() => setActiveKey(null)}
              onFocus={() => setActiveKey(key)}
              onBlur={() => setActiveKey(null)}
              onPointerDown={(event) => {
                if (event.pointerType !== 'mouse') setActiveKey((current) => current === key ? null : key)
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
      {hasGroupLegend && <div className="donut-group-key" aria-label="Main expense group percentages">{groups.map((group) => <span key={group.id}><i style={{ background: group.color }} aria-hidden="true" /><b>{group.name}</b><strong>{formatPercentage(group.percentage)}%</strong></span>)}</div>}
    </div>
  )
}

function RecordSectionCard({
  type,
  period,
  total,
  categories,
  expenseGroups,
  onOpenCategory,
}: {
  type: CategoryType
  period: string
  total: number
  categories: CategoryBreakdown[]
  expenseGroups: ExpenseGroup[]
  onOpenCategory: (type: CategoryType, category: CategoryBreakdown) => void
}) {
  const meta = categoryMeta[type]
  const Icon = meta.icon
  const categoryRow = (category: CategoryBreakdown) => <button className="category-breakdown-row category-breakdown-button" type="button" key={category.id} onClick={() => onOpenCategory(type, category)} aria-label={`View and edit ${category.name} entries`}>
    <span className="category-color" style={{ background: category.color }} aria-hidden="true" />
    <span className="category-breakdown-name"><strong>{category.name}</strong><span className="category-progress" aria-hidden="true"><i style={{ width: `${category.percentage}%`, background: category.color }} /></span></span>
    <span className="category-breakdown-value"><strong>{formatCurrency(category.amount)}</strong><small>{category.percentage.toFixed(category.percentage > 0 && category.percentage < 1 ? 1 : 0)}%</small></span>
  </button>
  const groupedExpenses = type === 'expense'
    ? [
        ...expenseGroups.map((group, index) => ({
          id: group.id,
          name: group.name,
          color: expenseGroupColors[index % expenseGroupColors.length],
          categories: categories.filter((category) => category.expenseGroupId === group.id),
        })),
        {
          id: 'ungrouped',
          name: 'Unassigned',
          color: '#687386',
          categories: categories.filter((category) => !expenseGroups.some((group) => group.id === category.expenseGroupId)),
        },
      ].filter((group) => group.categories.length > 0)
    : []
  const donutGroups: DonutGroupBreakdown[] = groupedExpenses.map((group) => {
    const amount = group.categories.reduce((sum, category) => sum + category.amount, 0)
    return { ...group, amount, percentage: total > 0 ? (amount / total) * 100 : 0 }
  })

  return (
    <article className={`record-section-card ${type}`}>
      <header className="record-section-heading">
        <span className={`record-section-icon ${type}`}><Icon weight="duotone" aria-hidden="true" /></span>
        <div><p>{meta.label}</p><strong>{formatCurrency(total)}</strong><small>{formatMonth(period)}</small></div>
      </header>
      <div className="record-section-body">
        <DonutChart label={meta.label} total={total} categories={categories} groups={type === 'expense' ? donutGroups : undefined} />
        {categories.length === 0 ? <div className="category-empty"><p>No {meta.label.toLocaleLowerCase('en')} categories yet.</p><a href="#settings">Add categories in Settings</a></div> : type === 'expense' ? <div className="category-breakdown-list expense-breakdown-list">
          {groupedExpenses.map((group) => <section className="expense-breakdown-group" key={group.id}>
            <header><strong>{group.name}</strong><span>{formatCurrency(group.categories.reduce((sum, category) => sum + category.amount, 0))}</span></header>
            {group.categories.map(categoryRow)}
          </section>)}
        </div> : <div className="category-breakdown-list">{categories.map(categoryRow)}</div>}
      </div>
    </article>
  )
}

function EditableLedgerEntryRow({
  entry,
  saving,
  onSave,
}: {
  entry: LedgerEntry
  saving: boolean
  onSave: (entry: LedgerEntry, amount: number, description: string) => Promise<boolean>
}) {
  const [amount, setAmount] = useState(String(Number(entry.amount)))
  const [description, setDescription] = useState(entry.description)

  useEffect(() => {
    setAmount(String(Number(entry.amount)))
    setDescription(entry.description)
  }, [entry.amount, entry.description])

  const numericAmount = Number(amount)
  const trimmedDescription = description.trim()
  const valid = amount.trim() !== '' && Number.isFinite(numericAmount) && numericAmount >= 0 && !!trimmedDescription
  const unchanged = numericAmount === Number(entry.amount) && trimmedDescription === entry.description
  const source = entry.source_type === 'google_sheets'
    ? [entry.source_sheet, entry.source_cell].filter(Boolean).join(' · ') || 'Imported entry'
    : 'Manual entry'

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid || unchanged) return
    await onSave(entry, numericAmount, trimmedDescription)
  }

  return <form className="category-entry-row" onSubmit={(event) => void handleSubmit(event)}>
    <div className="category-entry-meta"><strong>{formatEntryDate(entry.entry_date)}</strong><small>{source}</small></div>
    <label className="category-entry-remark"><span>Remark</span><input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} required /></label>
    <label className="category-entry-amount"><span>Amount (MYR)</span><input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>
    <button className="category-entry-save" type="submit" aria-label={`Save ${entry.description}`} disabled={saving || !valid || unchanged}>{saving ? <SpinnerGap className="spin" aria-hidden="true" /> : <CheckCircle weight="fill" aria-hidden="true" />}</button>
  </form>
}

function ExpenseGroupEditor({
  group,
  saving,
  onSave,
}: {
  group: ExpenseGroup
  saving: boolean
  onSave: (name: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(group.name)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setName(group.name), [group.name])
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const trimmedName = name.trim()
  const unchanged = trimmedName === group.name

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!trimmedName || unchanged) return
    if (await onSave(trimmedName)) setOpen(false)
  }

  const editorId = `expense-group-editor-${group.id}`
  return <div className="category-chip-editor main-group-chip-editor" ref={containerRef}>
    <button className="main-group-chip" type="button" aria-expanded={open} aria-controls={editorId} onClick={() => {
      setName(group.name)
      setOpen((current) => !current)
    }}><i aria-hidden="true" />{group.name}<small>Tap to rename</small></button>
    {open && <form className="category-edit-popover main-group-edit-popover" id={editorId} aria-label={`Rename ${group.name} expense group`} onSubmit={(event) => void handleSubmit(event)}>
      <span className="compact-editor-label">Main expense group</span>
      <div className="compact-edit-field">
        <input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} aria-label={`${group.name} group name`} maxLength={80} required />
        <button className="compact-save-button" type="submit" aria-label={`Save ${group.name} group`} disabled={saving || !trimmedName || unchanged}>{saving ? <SpinnerGap className="spin" aria-hidden="true" /> : <CheckCircle weight="fill" aria-hidden="true" />}</button>
      </div>
    </form>}
  </div>
}

function CategoryEditor({
  category,
  expenseGroups,
  saving,
  onSave,
}: {
  category: FinancialCategory
  expenseGroups: ExpenseGroup[]
  saving: boolean
  onSave: (name: string, expenseGroupId: string | null) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(category.name)
  const [expenseGroupId, setExpenseGroupId] = useState(category.expense_group_id ?? '')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setName(category.name)
    setExpenseGroupId(category.expense_group_id ?? '')
  }, [category.name, category.expense_group_id])
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const trimmedName = name.trim()
  const nextExpenseGroupId = category.category_type === 'expense' ? expenseGroupId : null
  const unchanged = trimmedName === category.name && nextExpenseGroupId === category.expense_group_id
  const missingExpenseGroup = category.category_type === 'expense' && !expenseGroupId

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!trimmedName || missingExpenseGroup || unchanged) return
    if (await onSave(trimmedName, nextExpenseGroupId)) setOpen(false)
  }

  const editorId = `category-editor-${category.id}`
  return <div className={`category-chip-editor ${category.category_type}`} ref={containerRef}>
    <button className="category-chip" type="button" aria-expanded={open} aria-controls={editorId} title="Tap to edit" onClick={() => {
      setName(category.name)
      setExpenseGroupId(category.expense_group_id ?? '')
      setOpen((current) => !current)
    }}><i aria-hidden="true" />{category.name}</button>
    {open && <form className="category-edit-popover" id={editorId} aria-label={`Edit ${category.name}`} onSubmit={(event) => void handleSubmit(event)}>
      <span className="compact-editor-label">Category name</span>
      <div className="compact-edit-field">
        <input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} aria-label={`Category name: ${category.name}`} maxLength={80} required />
        <button className="compact-save-button" type="submit" aria-label={`Save ${category.name}`} disabled={saving || !trimmedName || missingExpenseGroup || unchanged}>{saving ? <SpinnerGap className="spin" aria-hidden="true" /> : <CheckCircle weight="fill" aria-hidden="true" />}</button>
      </div>
      {category.category_type === 'expense' && <label className="compact-group-select"><span>Main group</span><select value={expenseGroupId} onChange={(event) => setExpenseGroupId(event.target.value)} required>
        <option value="" disabled>Choose group</option>
        {expenseGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select></label>}
    </form>}
  </div>
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
  const [expenseGroups, setExpenseGroups] = useState<ExpenseGroup[]>([])
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
  const [recordPeriod, setRecordPeriod] = useState(getCurrentMonthPeriod)
  const [entryDialogOpen, setEntryDialogOpen] = useState(false)
  const [selectedCategoryEntries, setSelectedCategoryEntries] = useState<{ type: CategoryType; category: CategoryBreakdown; period: string } | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [categorySaving, setCategorySaving] = useState<CategoryType | null>(null)
  const [categoryEditSavingId, setCategoryEditSavingId] = useState<string | null>(null)
  const [entryEditSavingId, setEntryEditSavingId] = useState<string | null>(null)
  const [expenseGroupSavingId, setExpenseGroupSavingId] = useState<string | null>(null)
  const [newExpenseGroupId, setNewExpenseGroupId] = useState('')
  const [newCategoryNames, setNewCategoryNames] = useState<Record<CategoryType, string>>({
    asset: '',
    income: '',
    investment: '',
    expense: '',
  })
  const entryDialogRef = useRef<HTMLDialogElement>(null)
  const categoryEntriesDialogRef = useRef<HTMLDialogElement>(null)
  const floatingAddButtonRef = useRef<HTMLButtonElement>(null)
  const firstTypeButtonRef = useRef<HTMLButtonElement>(null)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const firstNavItemRef = useRef<HTMLAnchorElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const handleHashChange = () => {
      setView(dashboardViewFromHash())
      setAddMenuOpen(false)
      setMobileNavOpen(false)
      setSelectedCategoryEntries(null)
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
    const dialog = categoryEntriesDialogRef.current
    if (!dialog) return
    if (selectedCategoryEntries && !dialog.open) dialog.showModal()
    if (!selectedCategoryEntries && dialog.open) dialog.close()
  }, [selectedCategoryEntries])

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

  useEffect(() => {
    document.documentElement.classList.toggle('mobile-nav-open', mobileNavOpen)
    if (!mobileNavOpen) return

    firstNavItemRef.current?.focus()
    const handleDrawerKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileNavOpen(false)
        mobileMenuButtonRef.current?.focus()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = [...(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])]
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', handleDrawerKeyDown)
    return () => {
      document.documentElement.classList.remove('mobile-nav-open')
      window.removeEventListener('keydown', handleDrawerKeyDown)
    }
  }, [mobileNavOpen])

  const showSnapshot = useCallback((snapshot: { expense_groups: ExpenseGroup[]; categories: FinancialCategory[]; records: MonthlyRecord[]; entries: LedgerEntry[] }) => {
    setExpenseGroups(snapshot.expense_groups)
    setCategories(snapshot.categories)
    setRecords(snapshot.records)
    setEntries(snapshot.entries)
  }, [])

  useEffect(() => {
    setNewExpenseGroupId((current) => expenseGroups.some((group) => group.id === current)
      ? current
      : expenseGroups[0]?.id ?? '')
  }, [expenseGroups])

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
  const expenseGroupTotals = expenseGroups.map((group) => ({
    ...group,
    amount: monthRecords
      .filter((record) => record.financial_categories?.category_type === 'expense' && record.financial_categories.expense_group_id === group.id)
      .reduce((total, record) => total + Number(record.amount), 0),
  }))
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
      const expenseGroupOrder = new Map(expenseGroups.map((group, index) => [group.id, index]))
      const breakdown: CategoryBreakdown[] = sectionCategories
        .map((category, index) => {
          const amount = amountByName.get(category.name.toLocaleLowerCase('en')) ?? 0
          return {
            id: category.id,
            name: category.name,
            amount,
            percentage: total > 0 ? (amount / total) * 100 : 0,
            color: chartColors[index % chartColors.length],
            expenseGroupId: category.expense_group_id,
          }
        })
        .sort((a, b) => {
          if (sectionType === 'expense') {
            const groupDifference = (expenseGroupOrder.get(a.expenseGroupId ?? '') ?? expenseGroups.length) - (expenseGroupOrder.get(b.expenseGroupId ?? '') ?? expenseGroups.length)
            if (groupDifference !== 0) return groupDifference
          }
          return b.amount - a.amount || a.name.localeCompare(b.name)
        })
      return { type: sectionType, total, categories: breakdown }
    })
  }, [categories, expenseGroups, records, summaryPeriod])
  const selectedCategorySummary = selectedCategoryEntries
    ? recordSections
        .find((section) => section.type === selectedCategoryEntries.type)
        ?.categories.find((category) => category.id === selectedCategoryEntries.category.id) ?? selectedCategoryEntries.category
    : null
  const categoryLedgerEntries = useMemo(() => {
    if (!selectedCategoryEntries) return []
    return entries
      .filter((entry) => entry.period === selectedCategoryEntries.period && (
        entry.category_id === selectedCategoryEntries.category.id ||
        (entry.financial_categories?.category_type === selectedCategoryEntries.type &&
          entry.financial_categories.name.toLocaleLowerCase('en') === selectedCategoryEntries.category.name.toLocaleLowerCase('en'))
      ))
      .sort((a, b) => b.entry_date.localeCompare(a.entry_date) || (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  }, [entries, selectedCategoryEntries])

  async function handleUpdateLedgerEntry(entry: LedgerEntry, nextAmount: number, nextDescription: string) {
    if (!Number.isFinite(nextAmount) || nextAmount < 0 || !nextDescription.trim()) return false
    const category = categories.find((item) => item.id === entry.category_id) ?? categories.find((item) =>
      item.category_type === entry.financial_categories?.category_type &&
      item.name.toLocaleLowerCase('en') === entry.financial_categories?.name.toLocaleLowerCase('en'),
    )
    if (!category) {
      setNotice('This entry category is no longer available.')
      return false
    }

    setEntryEditSavingId(entry.id)
    setNotice('')
    try {
      const queued = await queueLedgerEntry({
        entryId: entry.id,
        userId: session.user.id,
        categoryType: category.category_type,
        categoryName: category.name,
        categorySortOrder: category.sort_order,
        expenseGroupId: category.expense_group_id,
        period: entry.period,
        entryDate: entry.entry_date,
        amount: nextAmount,
        description: nextDescription,
        sourceType: entry.source_type,
        sourceSheet: entry.source_sheet,
        sourceCell: entry.source_cell,
        sourceFormula: entry.source_formula,
        externalKey: entry.external_key,
      })
      showSnapshot(queued.snapshot)
      setPendingCount(queued.pendingCount)

      if (!navigator.onLine) {
        setSyncStatus('offline')
        setNotice('Entry updated on this device. It will sync automatically when you reconnect.')
        return true
      }

      setSyncStatus('syncing')
      await syncPendingChanges(session.user.id)
      const remote = await refreshRemoteSnapshot(session.user.id)
      showSnapshot(remote.snapshot)
      setPendingCount(remote.pendingCount)
      setSyncStatus(remote.pendingCount > 0 ? 'pending' : 'synced')
      setLoadError('')
      setNotice(`${category.name} entry updated.`)
      return true
    } catch (error) {
      const queued = await getPendingChangeCount(session.user.id).catch(() => 0)
      setPendingCount(queued)
      setSyncStatus(navigator.onLine ? 'pending' : 'offline')
      setNotice(queued > 0 ? 'Entry updated on this device. Sync will retry automatically.' : messageFrom(error))
      if (!isNetworkError(error) && queued === 0) setLoadError(messageFrom(error))
      return queued > 0
    } finally {
      setEntryEditSavingId(null)
    }
  }

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
    if (categoryType === 'expense' && !newExpenseGroupId) {
      setNotice('Expense groups are not ready yet. Run the latest database migration, then try again.')
      return
    }
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
        expenseGroupId: categoryType === 'expense' ? newExpenseGroupId : null,
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

  async function handleUpdateCategory(category: FinancialCategory, nextName: string, nextExpenseGroupId: string | null) {
    const trimmedName = nextName.trim()
    if (!trimmedName) return false
    if (category.category_type === 'expense' && !expenseGroups.some((group) => group.id === nextExpenseGroupId)) {
      setNotice('Choose a valid expense group before saving this category.')
      return false
    }
    if (categories.some((item) =>
      item.id !== category.id &&
      item.category_type === category.category_type &&
      item.name.toLocaleLowerCase('en') === trimmedName.toLocaleLowerCase('en'),
    )) {
      setNotice(`${trimmedName} already exists under ${categoryMeta[category.category_type].label}.`)
      return false
    }
    if (!navigator.onLine) {
      setNotice('Reconnect to rename or move an existing category. New categories can still be added offline.')
      return false
    }

    setCategoryEditSavingId(category.id)
    setSyncStatus('syncing')
    setNotice('')
    try {
      await syncPendingChanges(session.user.id)
      const { error } = await supabase
        .from('worthdelta_financial_categories')
        .update({
          name: trimmedName,
          expense_group_id: category.category_type === 'expense' ? nextExpenseGroupId : null,
        })
        .eq('id', category.id)
        .eq('user_id', session.user.id)
      if (error) throw error

      const remote = await refreshRemoteSnapshot(session.user.id)
      showSnapshot(remote.snapshot)
      setPendingCount(remote.pendingCount)
      setSyncStatus(remote.pendingCount > 0 ? 'pending' : 'synced')
      setLoadError('')
      setNotice(`${trimmedName} updated.`)
      return true
    } catch (error) {
      const queued = await getPendingChangeCount(session.user.id).catch(() => 0)
      setPendingCount(queued)
      setSyncStatus(navigator.onLine ? 'pending' : 'offline')
      setNotice(messageFrom(error))
      return false
    } finally {
      setCategoryEditSavingId(null)
    }
  }

  async function handleUpdateExpenseGroup(group: ExpenseGroup, nextName: string) {
    const trimmedName = nextName.trim()
    if (!trimmedName) return false
    if (expenseGroups.some((item) =>
      item.id !== group.id && item.name.toLocaleLowerCase('en') === trimmedName.toLocaleLowerCase('en'),
    )) {
      setNotice(`An expense group named ${trimmedName} already exists.`)
      return false
    }
    if (!navigator.onLine) {
      setNotice('Reconnect to rename a main expense group.')
      return false
    }

    setExpenseGroupSavingId(group.id)
    setSyncStatus('syncing')
    setNotice('')
    try {
      await syncPendingChanges(session.user.id)
      const { error } = await supabase
        .from('worthdelta_expense_groups')
        .update({ name: trimmedName })
        .eq('id', group.id)
        .eq('user_id', session.user.id)
      if (error) throw error

      const remote = await refreshRemoteSnapshot(session.user.id)
      showSnapshot(remote.snapshot)
      setPendingCount(remote.pendingCount)
      setSyncStatus(remote.pendingCount > 0 ? 'pending' : 'synced')
      setLoadError('')
      setNotice(`Expense group renamed to ${trimmedName}.`)
      return true
    } catch (error) {
      const queued = await getPendingChangeCount(session.user.id).catch(() => 0)
      setPendingCount(queued)
      setSyncStatus(navigator.onLine ? 'pending' : 'offline')
      setNotice(messageFrom(error))
      return false
    } finally {
      setExpenseGroupSavingId(null)
    }
  }

  const filteredCategories = categories.filter((category) => category.category_type === type)
  const ungroupedExpenseCategories = type === 'expense'
    ? filteredCategories.filter((category) => !expenseGroups.some((group) => group.id === category.expense_group_id))
    : []
  const EntryTypeIcon = categoryMeta[type].icon
  const SelectedCategoryIcon = selectedCategoryEntries ? categoryMeta[selectedCategoryEntries.type].icon : Receipt
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
  const databaseSetupRequired = /schema cache|PGRST20[045]|could not find the table|expense_group_id/i.test(loadError)
  const viewCopy = view === 'overview'
    ? { title: 'Personal finance dashboard', lead: 'Every year, in view.', detail: `Latest asset snapshot: ${formatMonth(activePeriod)}` }
    : view === 'records'
      ? { title: 'Your financial records', lead: 'Every category, in view.', detail: 'Tap a category to view and edit its entries' }
      : { title: 'Category settings', lead: 'Make WorthDelta yours.', detail: 'Edit every category and organise expenses into main groups' }

  return (
    <div className="dashboard-shell">
      <header className="mobile-topbar">
        <button ref={mobileMenuButtonRef} className="mobile-menu-button" type="button" aria-label="Open navigation menu" aria-controls="dashboard-sidebar" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}><List weight="bold" aria-hidden="true" /></button>
        <a className="brand brand-light" href="#overview" aria-label="WorthDelta overview"><span className="brand-mark app-icon-mark" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}worthdelta-icon.png`} alt="" /></span><span>WorthDelta</span></a>
      </header>

      {mobileNavOpen && <button className="mobile-nav-scrim" type="button" aria-label="Close navigation menu" onClick={() => { setMobileNavOpen(false); mobileMenuButtonRef.current?.focus() }} />}

      <aside ref={sidebarRef} id="dashboard-sidebar" className={`sidebar ${mobileNavOpen ? 'mobile-open' : ''}`}>
        <button className="sidebar-close-button" type="button" aria-label="Close navigation menu" onClick={() => { setMobileNavOpen(false); mobileMenuButtonRef.current?.focus() }}><X weight="bold" aria-hidden="true" /></button>
        <a className="brand brand-light" href="#overview" aria-label="WorthDelta overview" onClick={() => setMobileNavOpen(false)}><span className="brand-mark app-icon-mark" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}worthdelta-icon.png`} alt="" /></span><span>WorthDelta</span></a>
        <nav aria-label="Dashboard"><a ref={firstNavItemRef} className={`nav-item ${view === 'overview' ? 'active' : ''}`} href="#overview" onClick={() => setMobileNavOpen(false)}><ChartLineUp weight="duotone" aria-hidden="true" />Overview</a><a className={`nav-item ${view === 'records' ? 'active' : ''}`} href="#records" onClick={() => setMobileNavOpen(false)}><Receipt weight="duotone" aria-hidden="true" />Records</a><a className={`nav-item ${view === 'settings' ? 'active' : ''}`} href="#settings" onClick={() => setMobileNavOpen(false)}><GearSix weight="duotone" aria-hidden="true" />Settings</a></nav>
        <div className="sidebar-user"><span className="avatar">{(session.user.email?.[0] ?? 'W').toUpperCase()}</span><span><strong>{session.user.user_metadata.full_name ?? 'WorthDelta user'}</strong><small>{session.user.email}</small></span><button type="button" onClick={() => void supabase.auth.signOut()} aria-label="Sign out"><SignOut aria-hidden="true" /></button></div>
      </aside>

      <main className="dashboard-main">
        <header className="dashboard-header"><div><h1>{viewCopy.title}</h1><p className="header-subtitle"><strong>{viewCopy.lead}</strong><span aria-hidden="true">·</span><span>{viewCopy.detail}</span></p></div><div className="header-actions"><span className={`sync-status ${syncStatus}`} role="status" aria-live="polite"><SyncIcon className={syncStatus === 'syncing' ? 'spin' : ''} aria-hidden="true" />{syncLabel}</span></div></header>

        {loadError && <section className="setup-banner" role="alert"><Database aria-hidden="true" /><div><strong>{databaseSetupRequired ? 'Database setup required' : 'Sync paused'}</strong><p>{databaseSetupRequired ? 'Run the included migrations to enable expense groups and editable category assignments.' : `${loadError} Your locally saved changes are safe and will retry automatically.`}</p>{databaseSetupRequired && <code>supabase/migrations/20260817000000_expense_groups_and_editable_categories.sql</code>}</div></section>}
        {notice && <p className="notice" role="status">{notice}</p>}

        {view === 'overview' ? <>
        <section className="metric-grid" aria-label="Latest monthly summary">
          <article><span>Asset value</span><strong>{formatCurrency(assets)}</strong><small>Current snapshot</small></article>
          <article><span>Monthly income</span><strong>{formatCurrency(income)}</strong><small>{formatMonth(activePeriod)}</small></article>
          <article><span>Monthly expenses</span><strong>{formatCurrency(expenses)}</strong><small className="expense-metric-breakdown">{expenseGroupTotals.length ? expenseGroupTotals.map((group) => <span key={group.id}>{group.name} {formatCurrency(group.amount)}</span>) : income ? `${Math.round((expenses / income) * 100)}% of income` : 'No income recorded'}</small></article>
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
          {recordSections.map((section) => <RecordSectionCard key={section.type} type={section.type} period={summaryPeriod} total={section.total} categories={section.categories} expenseGroups={expenseGroups} onOpenCategory={(sectionType, category) => setSelectedCategoryEntries({ type: sectionType, category, period: summaryPeriod })} />)}
        </section>}
        </> : <>
        <section className="category-settings-grid" aria-label="Financial category settings">
          {(Object.keys(categoryMeta) as CategoryType[]).map((categoryType) => {
            const meta = categoryMeta[categoryType]
            const Icon = meta.icon
            const sectionCategories = categories.filter((category) => category.category_type === categoryType)
            const unassignedSettingsCategories = categoryType === 'expense'
              ? sectionCategories.filter((category) => !expenseGroups.some((group) => group.id === category.expense_group_id))
              : []
            return <article className={`category-settings-card ${categoryType}`} key={categoryType}>
              <header><span className={`record-section-icon ${categoryType}`}><Icon weight="duotone" aria-hidden="true" /></span><div><h2>{meta.label}</h2><p>{sectionCategories.length} {sectionCategories.length === 1 ? 'category' : 'categories'}</p></div></header>
              <form className={`category-add-form ${categoryType === 'expense' ? 'with-group' : ''}`} onSubmit={(event) => void handleAddCategory(event, categoryType)}>
                <label><span className="sr-only">New {meta.label.toLocaleLowerCase('en')} category</span><input value={newCategoryNames[categoryType]} onChange={(event) => setNewCategoryNames((current) => ({ ...current, [categoryType]: event.target.value }))} placeholder={`New ${meta.label.toLocaleLowerCase('en')} category`} maxLength={80} required /></label>
                {categoryType === 'expense' && <label><span className="sr-only">Main group for new expense category</span><select value={newExpenseGroupId} onChange={(event) => setNewExpenseGroupId(event.target.value)} required><option value="" disabled>Choose group</option>{expenseGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
                <button type="submit" disabled={categorySaving !== null || (categoryType === 'expense' && !newExpenseGroupId)}>{categorySaving === categoryType ? <SpinnerGap className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}Add</button>
              </form>
              {categoryType === 'expense' ? expenseGroups.length === 0 ? <p className="settings-empty">Expense groups are not available yet.</p> : <div className="expense-settings-groups">
                {expenseGroups.map((group, groupIndex) => {
                  const groupCategories = sectionCategories.filter((category) => category.expense_group_id === group.id)
                  return <section className={`expense-settings-group tone-${groupIndex % 2}`} key={group.id}>
                    <header><ExpenseGroupEditor group={group} saving={expenseGroupSavingId === group.id} onSave={(name) => handleUpdateExpenseGroup(group, name)} /><span>{groupCategories.length} {groupCategories.length === 1 ? 'category' : 'categories'}</span></header>
                    {groupCategories.length === 0 ? <p className="expense-group-empty">No categories assigned.</p> : <div className="category-chip-list">{groupCategories.map((category) => <CategoryEditor key={category.id} category={category} expenseGroups={expenseGroups} saving={categoryEditSavingId === category.id} onSave={(name, expenseGroupId) => handleUpdateCategory(category, name, expenseGroupId)} />)}</div>}
                  </section>
                })}
                {unassignedSettingsCategories.length > 0 && <section className="expense-settings-group unassigned"><header><strong>Unassigned</strong><span>{unassignedSettingsCategories.length} categories</span></header><div className="category-chip-list">{unassignedSettingsCategories.map((category) => <CategoryEditor key={category.id} category={category} expenseGroups={expenseGroups} saving={categoryEditSavingId === category.id} onSave={(name, expenseGroupId) => handleUpdateCategory(category, name, expenseGroupId)} />)}</div></section>}
              </div> : sectionCategories.length === 0 ? <p className="settings-empty">No categories here yet.</p> : <div className="category-chip-list section-category-chips">{sectionCategories.map((category) => <CategoryEditor key={category.id} category={category} expenseGroups={expenseGroups} saving={categoryEditSavingId === category.id} onSave={(name, expenseGroupId) => handleUpdateCategory(category, name, expenseGroupId)} />)}</div>}
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
            <header className="entry-dialog-heading"><div><p className="eyebrow">New record</p><h2 id="entry-dialog-title">Add a new entry</h2><p>Every entry updates its monthly category total.</p></div><button type="button" onClick={() => setEntryDialogOpen(false)} aria-label="Close add entry form"><X aria-hidden="true" /></button></header>
            <form onSubmit={handleSave}>
              <div className={`entry-type-badge ${type}`}><EntryTypeIcon weight="duotone" aria-hidden="true" /><span>{categoryMeta[type].label}</span></div>
              <label><span>Category</span><select value={categoryName} onChange={(event) => setCategoryName(event.target.value)} required><option value="" disabled>{filteredCategories.length ? 'Choose a category' : 'Add a category in Settings first'}</option>{type === 'expense' ? <>
                {expenseGroups.map((group) => { const groupCategories = filteredCategories.filter((category) => category.expense_group_id === group.id); return groupCategories.length > 0 ? <optgroup key={group.id} label={group.name}>{groupCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</optgroup> : null })}
                {ungroupedExpenseCategories.length > 0 && <optgroup label="Unassigned">{ungroupedExpenseCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</optgroup>}
              </> : filteredCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label>
              {filteredCategories.length === 0 && <a className="dialog-settings-link" href="#settings" onClick={() => setEntryDialogOpen(false)}><GearSix aria-hidden="true" />Open category settings</a>}
              <label><span>Description</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What makes up this amount?" maxLength={200} required /></label>
              <div className="form-row"><label><span>Date</span><input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required /></label><label><span>Amount (MYR)</span><input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required /></label></div>
              <div className="entry-dialog-actions"><button className="dialog-cancel-button" type="button" onClick={() => setEntryDialogOpen(false)}>Cancel</button><button className="primary-action-button" type="submit" disabled={saving || !!loadError || filteredCategories.length === 0}>{saving ? <SpinnerGap className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}Save entry</button></div>
            </form>
          </div>
        </dialog>

        <dialog className="entry-dialog category-entries-dialog" ref={categoryEntriesDialogRef} aria-labelledby="category-entries-title" onClose={() => setSelectedCategoryEntries(null)} onCancel={() => setSelectedCategoryEntries(null)} onClick={(event) => { if (event.target === event.currentTarget) setSelectedCategoryEntries(null) }}>
          {selectedCategoryEntries && selectedCategorySummary && <div className="entry-dialog-card category-entries-card">
            <header className="entry-dialog-heading"><div><p className="eyebrow">{categoryMeta[selectedCategoryEntries.type].label} · {formatMonth(selectedCategoryEntries.period)}</p><h2 id="category-entries-title">{selectedCategorySummary.name}</h2><p>{categoryLedgerEntries.length} {categoryLedgerEntries.length === 1 ? 'entry' : 'entries'} · {formatCurrency(selectedCategorySummary.amount)} category total</p></div><button type="button" onClick={() => setSelectedCategoryEntries(null)} aria-label="Close category entries"><X aria-hidden="true" /></button></header>
            <div className={`entry-type-badge ${selectedCategoryEntries.type}`}><SelectedCategoryIcon weight="duotone" aria-hidden="true" /><span>Amount and remark details</span></div>
            {categoryLedgerEntries.length === 0 ? <div className="category-entry-empty"><Receipt aria-hidden="true" /><strong>No itemised entries for this month</strong><p>The category total exists, but no amount-and-remark breakdown is available.</p></div> : <div className="category-entry-list">{categoryLedgerEntries.map((entry) => <EditableLedgerEntryRow key={entry.id} entry={entry} saving={entryEditSavingId === entry.id} onSave={handleUpdateLedgerEntry} />)}</div>}
          </div>}
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
