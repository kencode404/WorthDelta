import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  ArrowsOut,
  CheckCircle,
  DownloadSimple,
  ChartLineUp,
  CloudArrowUp,
  Database,
  GearSix,
  List,
  Plus,
  Lock,
  Receipt,
  SignOut,
  Trash,
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
import {
  biometricAvailable,
  clearBiometric,
  clearPin,
  hasBiometric,
  hasPin,
  registerBiometric,
  setPin,
  verifyBiometric,
  verifyPin,
} from './lib/appLock'
import { fetchMyrRate } from './lib/exchangeRate'
import { captureChartImage, downloadWorkbook } from './lib/exportWorkbook'
import { ensureFreshSession, isExpiredTokenError, supabase } from './lib/supabase'
import type { CategoryType, ExpenseGroup, FinancialCategory, LedgerEntry, MonthlyRecord } from './types'
import './App.css'

const categoryMeta: Record<CategoryType, { label: string; icon: typeof Wallet }> = {
  asset: { label: 'Initial Assets', icon: Wallet },
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

const changeLabel = (value: number) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1)}%`

const formatPercentage = (value: number) =>
  value.toFixed(value > 0 && value < 1 ? 1 : 0)

const formatMonth = (period: string) =>
  new Intl.DateTimeFormat('en-MY', { month: 'short', year: 'numeric' }).format(
    new Date(`${period.slice(0, 7)}-02T00:00:00`),
  )

const formatShortMonth = (period: string) =>
  new Intl.DateTimeFormat('en-MY', { month: 'short' }).format(new Date(`${period.slice(0, 7)}-02T00:00:00`))

const formatEntryDate = (date: string) =>
  new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(`${date.slice(0, 10)}T00:00:00`),
  )

const smoothPath = (points: Array<{ x: number; y: number }>) => {
  if (points.length < 2) return points.length ? `M ${points[0].x} ${points[0].y}` : ''
  const deltas = points.slice(0, -1).map((point, index) => (points[index + 1].y - point.y) / (points[index + 1].x - point.x))
  const slopes = points.map((_, index) => {
    if (index === 0) return deltas[0]
    if (index === points.length - 1) return deltas[deltas.length - 1]
    return deltas[index - 1] * deltas[index] <= 0 ? 0 : (deltas[index - 1] + deltas[index]) / 2
  })
  // Fritsch-Carlson limiter: keeps the curve monotone so it never bulges past a real value
  deltas.forEach((delta, index) => {
    if (delta === 0) {
      slopes[index] = 0
      slopes[index + 1] = 0
      return
    }
    const magnitude = Math.hypot(slopes[index] / delta, slopes[index + 1] / delta)
    if (magnitude > 3) {
      slopes[index] = (3 / magnitude) * (slopes[index] / delta) * delta
      slopes[index + 1] = (3 / magnitude) * (slopes[index + 1] / delta) * delta
    }
  })
  return points.map((point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`
    const previous = points[index - 1]
    const step = (point.x - previous.x) / 3
    return `C ${previous.x + step} ${previous.y + slopes[index - 1] * step} ${point.x - step} ${point.y - slopes[index] * step} ${point.x} ${point.y}`
  }).join(' ')
}

const getPreviousMonthPeriod = (period: string) => {
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  const previous = new Date(year, month - 2, 1)
  return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-01`
}

// keep today's day number, but sit inside whichever month is on screen
const defaultEntryDate = (period: string) => {
  const today = new Date()
  const iso = today.toISOString().slice(0, 10)
  if (period.slice(0, 7) === iso.slice(0, 7)) return iso
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  const lastDay = new Date(year, month, 0).getDate()
  const day = Math.min(today.getDate(), lastDay)
  return `${period.slice(0, 7)}-${String(day).padStart(2, '0')}`
}

const addMonths = (date: string, count: number) => {
  const day = Number(date.slice(8, 10))
  const target = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + count, 1)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
}

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
  if (window.location.hash === '#overview') return 'overview'
  if (window.location.hash === '#settings') return 'settings'
  return 'records'
}

interface AnnualSummary {
  year: number
  income: number
  expenses: number
  investments: number
  netWorth: number
  netWorthChange: number
  netWorthChangePercent: number | null
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
  archived?: boolean
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
const rateCacheKey = (code: string) => `worthdelta-rate-${code}`

const readCachedRate = (code: string) => {
  try {
    const raw = window.localStorage.getItem(rateCacheKey(code))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { rate: number; at: string }
    return typeof parsed.rate === 'number' ? parsed : null
  } catch {
    return null
  }
}

const writeCachedRate = (code: string, rate: number) => {
  try {
    window.localStorage.setItem(rateCacheKey(code), JSON.stringify({ rate, at: new Date().toISOString() }))
  } catch {
    // a full or blocked store just means no offline fallback next time
  }
}

const CURRENCIES = ['MYR', 'USD', 'SGD', 'EUR', 'GBP', 'JPY', 'AUD', 'CNY', 'HKD', 'THB', 'IDR', 'PHP', 'VND', 'KRW', 'TWD', 'INR', 'CAD', 'CHF', 'NZD', 'AED']

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
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const activeCategory = categories.find((category) => activeKey === category.id)
  const selectedGroup = groups.find((group) => group.id === selectedGroupId)
  const active = selectedGroup ?? activeCategory
  const visibleCategories = categories.filter((category) => category.amount > 0)
  const hasGroupLegend = groups.length > 0
  const hasGroupSeparation = new Set(visibleCategories.map((category) => category.expenseGroupId ?? 'ungrouped')).size > 1
  const groupBoundaryIndexes = visibleCategories.flatMap((category, index) => {
    const nextCategory = visibleCategories[(index + 1) % visibleCategories.length]
    return hasGroupSeparation && category.expenseGroupId !== nextCategory?.expenseGroupId ? [index] : []
  })
  const sharedGroupGap = groupBoundaryIndexes.length > 0
    ? Math.min(1.4, ...groupBoundaryIndexes.map((index) => visibleCategories[index].percentage * .35))
    : 0
  let categoryOffset = 0
  const categorySegments = visibleCategories.map((category, index) => {
    const dashOffset = -categoryOffset
    const groupGap = groupBoundaryIndexes.includes(index) ? sharedGroupGap : 0
    const visiblePercentage = category.percentage - groupGap
    categoryOffset += category.percentage
    return { category, dashOffset, visiblePercentage }
  })

  return (
    <div className={`donut-wrap ${selectedGroup ? 'group-selected' : ''}`}>
      <div className="donut-canvas">
        <svg className="donut-chart" viewBox="0 0 120 120" role="img" aria-label={`${label} category proportions${hasGroupLegend ? '. Main group percentages are listed below' : ''}. Total ${formatCurrency(total)}.`}>
          <circle className="donut-track" cx="60" cy="60" r="43" pathLength="100" />
          {categorySegments.map(({ category, dashOffset, visiblePercentage }) => {
            const key = category.id
            const belongsToSelectedGroup = selectedGroupId === (category.expenseGroupId ?? 'ungrouped')
            return <circle
              className={`donut-slice ${selectedGroupId ? belongsToSelectedGroup ? 'group-selected-slice' : 'group-muted-slice' : ''}`}
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
      {hasGroupLegend && <div className="donut-group-key" aria-label="Select a main expense group">{groups.map((group) => <button className={selectedGroupId === group.id ? 'selected' : ''} key={group.id} type="button" aria-pressed={selectedGroupId === group.id} onClick={() => setSelectedGroupId((current) => current === group.id ? null : group.id)}><i style={{ background: group.color }} aria-hidden="true" /><b>{group.name}</b><strong>{formatPercentage(group.percentage)}%</strong></button>)}</div>}
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
  const groupedCategories = expenseGroups.length > 0
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
  // liquidity = everything except the non-current groups (any asset group after the first)
  const nonCurrentTotal = type === 'asset'
    ? categories
        .filter((category) => expenseGroups.slice(1).some((group) => group.id === category.expenseGroupId))
        .reduce((sum, category) => sum + category.amount, 0)
    : 0
  const showLiquidity = type === 'asset' && expenseGroups.length > 1 && total > 0
  const donutGroups: DonutGroupBreakdown[] = groupedCategories.map((group) => {
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
        <div className="record-donut-column">
          <DonutChart label={meta.label} total={total} categories={categories} groups={donutGroups.length > 0 ? donutGroups : undefined} />
          {showLiquidity && <p className="liquidity-readout"><span>Liquidity</span><strong>{formatCurrency(total - nonCurrentTotal)}</strong></p>}
        </div>
        {categories.length === 0 ? <div className="category-empty"><p>No {meta.label.toLocaleLowerCase('en')} categories yet.</p><a href="#settings">Add categories in Settings</a></div> : groupedCategories.length > 0 ? <div className="category-breakdown-list expense-breakdown-list">
          {groupedCategories.map((group) => <section className="expense-breakdown-group" key={group.id}>
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
  onDelete,
}: {
  entry: LedgerEntry
  saving: boolean
  onSave: (entry: LedgerEntry, amount: number, description: string) => Promise<boolean>
  onDelete: (entry: LedgerEntry) => Promise<boolean>
}) {
  const [amount, setAmount] = useState(String(Number(entry.amount)))
  const [description, setDescription] = useState(entry.description)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    setAmount(String(Number(entry.amount)))
    setDescription(entry.description)
  }, [entry.amount, entry.description])

  const numericAmount = Number(amount)
  const trimmedDescription = description.trim()
  const valid = amount.trim() !== '' && Number.isFinite(numericAmount) && numericAmount >= 0
  const unchanged = numericAmount === Number(entry.amount) && trimmedDescription === entry.description

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid || unchanged) return
    await onSave(entry, numericAmount, trimmedDescription)
  }

  return <form className="category-entry-row" onSubmit={(event) => void handleSubmit(event)}>
    <div className="category-entry-meta"><strong>{formatEntryDate(entry.entry_date)}</strong></div>
    <label className="category-entry-remark"><span>Remark</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What did you buy?" maxLength={200} /></label>
    <label className="category-entry-amount"><span>Amount (MYR)</span><input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>
    <button className="category-entry-save" type="submit" aria-label={`Save the ${formatEntryDate(entry.entry_date)} entry`} disabled={saving || !valid || unchanged}>{saving ? <SpinnerGap className="spin" aria-hidden="true" /> : <CheckCircle weight="fill" aria-hidden="true" />}</button>
    <button className="category-entry-delete" type="button" aria-label={`Delete the ${formatEntryDate(entry.entry_date)} entry`} disabled={saving} onClick={() => setConfirmingDelete(true)}><Trash aria-hidden="true" /></button>
    {confirmingDelete && <div className="entry-delete-confirm" role="alert">
      <p>Delete this entry? {formatCurrency(Number(entry.amount))} comes off the month's category total.</p>
      <div>
        <button type="button" className="compact-delete-cancel" onClick={() => setConfirmingDelete(false)}>Cancel</button>
        <button type="button" className="compact-delete-confirm-button" disabled={saving} onClick={() => void onDelete(entry)}>Delete</button>
      </div>
    </div>}
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
  onDelete,
  historyMonths,
}: {
  category: FinancialCategory
  expenseGroups: ExpenseGroup[]
  saving: boolean
  onSave: (name: string, expenseGroupId: string | null) => Promise<boolean>
  onDelete: () => Promise<boolean>
  historyMonths: number
}) {
  const keepsHistory = historyMonths > 0
  const [open, setOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
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
  useEffect(() => { if (!open) setConfirmingDelete(false) }, [open])

  const trimmedName = name.trim()
  const nextExpenseGroupId = expenseGroups.length > 0 ? expenseGroupId : null
  const unchanged = trimmedName === category.name && nextExpenseGroupId === category.expense_group_id
  const missingExpenseGroup = expenseGroups.length > 0 && !expenseGroupId

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
      {expenseGroups.length > 0 && <label className="compact-group-select"><span>Main group</span><select value={expenseGroupId} onChange={(event) => setExpenseGroupId(event.target.value)} required>
        <option value="" disabled>Choose group</option>
        {expenseGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select></label>}
      {confirmingDelete
        ? <div className={`compact-delete-confirm ${keepsHistory ? 'warning' : ''}`} role="alert">
            <p>{keepsHistory
              ? `Recorded in ${historyMonths} past ${historyMonths === 1 ? 'month' : 'months'}. Those amounts stay put — the category is archived, not deleted, and stops appearing for new entries.`
              : 'No amounts recorded against this category. It will be removed completely.'}</p>
            <div>
              <button type="button" className="compact-delete-cancel" onClick={() => setConfirmingDelete(false)}>Cancel</button>
              <button type="button" className="compact-delete-confirm-button" disabled={saving} onClick={() => void onDelete().then((done) => { if (done) setOpen(false) })}>{keepsHistory ? 'Archive' : 'Delete'}</button>
            </div>
          </div>
        : <button type="button" className="compact-delete-button" onClick={() => setConfirmingDelete(true)}>{keepsHistory ? 'Archive category' : 'Delete category'}</button>}
    </form>}
  </div>
}

interface MonthlyPoint {
  period: string
  income: number
  expenses: number
  investments: number
  worth: number | null
}

interface ChartPoint {
  key: string
  label: string
  income: number
  expenses: number
  investments: number
  worth: number | null
}

const RANGE_PRESETS = [
  { label: '1Y', months: 12 },
  { label: '3Y', months: 36 },
  { label: '5Y', months: 60 },
  { label: 'All', months: null },
]

// beyond this many months on screen the monthly detail turns to mush, so roll up to years
const YEARLY_THRESHOLD = 36

function AnnualChart({ points }: { points: MonthlyPoint[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [span, setSpan] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)
  const dragRef = useRef<{ x: number; offset: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const pointersRef = useRef(new Map<number, number>())
  const pinchRef = useRef<{ distance: number; midpoint: number; span: number; offset: number } | null>(null)
  const holdTimerRef = useRef<number | null>(null)
  const holdRef = useRef<{ x: number; offset: number } | null>(null)
  const touchStartRef = useRef<number | null>(null)
  const [holding, setHolding] = useState(false)

  const endHold = () => {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = null
    holdRef.current = null
    touchStartRef.current = null
    setHolding(false)
  }
  const [expanded, setExpanded] = useState(false)
  const [boxWidth, setBoxWidth] = useState(1080)
  const [boxHeight, setBoxHeight] = useState(0)
  // a finger scrolls the chart; a mouse keeps the drag-and-window behaviour.
  // Width would be the wrong test: a phone turned landscape is wide but still touch.
  const [touchDevice, setTouchDevice] = useState(() => window.matchMedia('(pointer: coarse)').matches)

  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)')
    const update = () => setTouchDevice(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const total = points.length

  // draw at the size we are actually given, so one unit is one pixel: nothing is
  // scaled down, nothing is clipped off the right, and the text stays legible
  useEffect(() => {
    const node = viewportRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry.contentRect.width)
      const nextHeight = Math.round(entry.contentRect.height)
      // ignore sub-pixel churn, which would otherwise re-render on every frame
      if (nextWidth > 0) setBoxWidth((current) => Math.abs(current - nextWidth) > 2 ? nextWidth : current)
      setBoxHeight((current) => Math.abs(current - nextHeight) > 6 ? nextHeight : current)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [expanded])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (expanded && !dialog.open) {
      dialog.showModal()
      // phones: turn sideways where the platform allows it. Android grants the lock
      // in fullscreen or in an installed PWA; iOS has no such API and simply stays
      // portrait. Rotating the device itself is what keeps taps and panning correct,
      // which a CSS rotation did not.
      if (window.matchMedia('(max-width: 820px)').matches) {
        const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> }
        const lockLandscape = () => { void orientation?.lock?.('landscape').catch(() => undefined) }
        const fullscreen = dialog.requestFullscreen?.()
        if (fullscreen) fullscreen.then(lockLandscape).catch(lockLandscape)
        else lockLandscape()
      }
    }
    if (!expanded && dialog.open) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
      ;(screen.orientation as ScreenOrientation & { unlock?: () => void }).unlock?.()
      dialog.close()
    }
  }, [expanded])

  // React registers onWheel passively, so preventDefault there is ignored and the
  // page scrolls behind the chart. Bind it natively instead.
  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 1) return
      event.preventDefault()
      setSpan((current) => {
        const next = Math.round((current ?? total) * (event.deltaY > 0 ? 1.25 : 0.8))
        return Math.max(3, Math.min(total, next))
      })
    }
    node.addEventListener('wheel', handleWheel, { passive: false })
    return () => node.removeEventListener('wheel', handleWheel)
  }, [total])

  if (points.length === 0) return <div className="chart-empty">Your progress will appear once records are added.</div>
  const containerWidth = Math.max(300, boxWidth)
  const scrollable = touchDevice
  const visibleCount = Math.max(2, Math.min(total, span ?? total))
  const maxOffset = Math.max(0, total - visibleCount)
  const start = Math.max(0, Math.min(maxOffset, maxOffset - offset))
  const visiblePoints = scrollable ? points : points.slice(start, start + visibleCount)
  const monthly = scrollable
    ? (containerWidth * (total / visibleCount)) / Math.max(1, total - 1) >= 16
    : visiblePoints.length <= YEARLY_THRESHOLD

  const chartPoints: ChartPoint[] = monthly
    ? visiblePoints.map((point) => ({
        key: point.period,
        label: `${formatShortMonth(point.period)} ${point.period.slice(2, 4)}`,
        income: point.income,
        expenses: point.expenses,
        investments: point.investments,
        worth: point.worth,
      }))
    : Object.values(visiblePoints.reduce<Record<string, ChartPoint & { lastWorth: number | null }>>((years, point) => {
        const year = point.period.slice(0, 4)
        const bucket = years[year] ?? { key: year, label: year, income: 0, expenses: 0, investments: 0, worth: null, lastWorth: null }
        bucket.income += point.income
        bucket.expenses += point.expenses
        bucket.investments += point.investments
        if (point.worth !== null) bucket.lastWorth = point.worth
        bucket.worth = bucket.lastWorth
        years[year] = bucket
        return years
      }, {}))

  // on a phone the drawing is as wide as the zoom asks for and the viewport scrolls
  const width = scrollable ? Math.round(containerWidth * Math.max(1, total / visibleCount)) : containerWidth
  const compact = containerWidth < 620
  const padding = compact
    ? { top: 26, right: 44, bottom: 30, left: 44 }
    : { top: 38, right: 72, bottom: 46, left: 70 }
  const plotHeight = expanded && boxHeight > 90
    ? Math.max(110, Math.min(compact ? 300 : 460, boxHeight - padding.top - padding.bottom - 6))
    : compact ? 200 : 296
  const height = padding.top + plotHeight + padding.bottom
  const plotWidth = width - padding.left - padding.right
  const base = padding.top + plotHeight

  const flowMax = Math.max(...chartPoints.flatMap((point) => [point.income, point.expenses, point.investments]), 1)
  const worthValues = chartPoints.map((point) => point.worth).filter((value): value is number => value !== null)
  const worthMax = Math.max(...worthValues, 1)
  const step = chartPoints.length > 1 ? plotWidth / (chartPoints.length - 1) : 0
  const xFor = (index: number) => chartPoints.length > 1 ? padding.left + index * step : padding.left + plotWidth / 2
  const yFlow = (value: number) => base - (value / flowMax) * plotHeight
  const yWorth = (value: number) => base - (value / worthMax) * plotHeight

  const flowSeries = [
    { key: 'income' as const, label: 'Income', color: '#218a70', area: true },
    { key: 'expenses' as const, label: 'Expenses', color: '#c25a1f', area: false },
    { key: 'investments' as const, label: 'Invested', color: '#477fc6', area: false },
  ]
  const flowPath = (key: 'income' | 'expenses' | 'investments') =>
    smoothPath(chartPoints.map((point, index) => ({ x: xFor(index), y: yFlow(point[key]) })))

  // the worth line breaks wherever a month has no asset snapshot
  const worthSegments: Array<Array<{ x: number; y: number }>> = []
  chartPoints.forEach((point, index) => {
    if (point.worth === null) {
      if (worthSegments.at(-1)?.length) worthSegments.push([])
      return
    }
    if (worthSegments.length === 0) worthSegments.push([])
    worthSegments[worthSegments.length - 1].push({ x: xFor(index), y: yWorth(point.worth) })
  })

  const active = activeIndex === null ? null : chartPoints[Math.min(activeIndex, chartPoints.length - 1)]
  const activeX = active ? xFor(Math.min(activeIndex!, chartPoints.length - 1)) : 0
  const tooltipWidth = compact ? 150 : 214
  const row = compact ? 15 : 21
  const tooltipHeight = row * (active?.worth === null ? 4 : 5) + 16
  const tooltipX = Math.max(padding.left, Math.min(activeX + 16, width - padding.right - tooltipWidth))

  const labelEvery = Math.max(1, Math.ceil(chartPoints.length / (compact ? 3 : 8)))
  const rangeLabel = `${chartPoints[0]?.label ?? ''} – ${chartPoints.at(-1)?.label ?? ''}`

  /**
   * Screen space and chart space are not the same box: the svg is letterboxed when
   * enlarged, wider than its wrapper inline, and rotated a quarter turn on a portrait
   * phone. getScreenCTM knows all of that, so let it do the conversion.
   */
  const localX = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return null
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    return point.matrixTransform(matrix.inverse()).x
  }

  const indexFromLocalX = (x: number) => {
    if (chartPoints.length < 2) return 0
    const ratio = (x - padding.left) / plotWidth
    return Math.max(0, Math.min(chartPoints.length - 1, Math.round(ratio * (chartPoints.length - 1))))
  }

  const twoFingers = () => {
    const [first, second] = [...pointersRef.current.values()]
    return { distance: Math.abs(first - second), midpoint: (first + second) / 2 }
  }

  const panBy = (localDelta: number, fromOffset: number) => {
    const movedPoints = (localDelta / plotWidth) * Math.max(1, chartPoints.length - 1)
    const perPoint = monthly ? 1 : 12
    setOffset(Math.max(0, Math.min(maxOffset, Math.round(fromOffset - movedPoints * perPoint))))
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const x = localX(event.clientX, event.clientY)
    if (x === null) return
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, x)

    // two fingers: spread to zoom, slide to pan
    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const { distance, midpoint } = twoFingers()
      if (distance > 8) {
        const next = Math.round(pinchRef.current.span * (pinchRef.current.distance / distance))
        setSpan(Math.max(3, Math.min(total, next)))
      }
      panBy(pinchRef.current.midpoint - midpoint, pinchRef.current.offset)
      return
    }

    // one finger reads values, the way a price chart scrubs; hold still for a
    // moment and the same finger switches to panning
    if (event.pointerType === 'touch') {
      if (scrollable) {
        setActiveIndex(indexFromLocalX(x))
        return
      }
      if (holdRef.current) {
        panBy(holdRef.current.x - x, holdRef.current.offset)
        return
      }
      if (touchStartRef.current !== null && Math.abs(x - touchStartRef.current) > 6 && holdTimerRef.current !== null) {
        window.clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
      setActiveIndex(indexFromLocalX(x))
      return
    }
    if (dragRef.current) {
      panBy(dragRef.current.x - x, dragRef.current.offset)
      return
    }
    setActiveIndex(indexFromLocalX(x))
  }

  const chartBody = (
    <div className={`annual-chart-wrap ${expanded ? 'expanded' : ''}`}>
      <div className="chart-toolbar">
        <div className="chart-legend" aria-hidden="true">
          {flowSeries.map((series) => <span key={series.key}><i className="legend-line" style={{ background: series.color }} />{series.label}</span>)}
          <span><i className="legend-line legend-dashed" />Net worth</span>
        </div>
        <div className="chart-tools">
        <div className="chart-range-controls" role="group" aria-label="Chart range">
          {RANGE_PRESETS.map((preset) => <button
            key={preset.label}
            type="button"
            className={(span ?? total) === (preset.months ?? total) ? 'active' : ''}
            aria-pressed={(span ?? total) === (preset.months ?? total)}
            onClick={() => {
              setSpan(preset.months)
              setOffset(0)
              setActiveIndex(null)
              if (scrollable) requestAnimationFrame(() => {
                const node = viewportRef.current
                if (node) node.scrollLeft = node.scrollWidth
              })
            }}
          >{preset.label}</button>)}
        </div>
        <button className="chart-expand-button" type="button" aria-label={expanded ? 'Close the enlarged chart' : 'Enlarge the chart'} onClick={() => setExpanded((current) => !current)}>
          {expanded ? <X weight="bold" aria-hidden="true" /> : <ArrowsOut weight="bold" aria-hidden="true" />}
        </button>
        </div>
      </div>
      <div className="chart-frame">
      <div
        ref={viewportRef}
        className={`chart-viewport ${holding ? 'panning' : ''}`}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => { setActiveIndex(null); dragRef.current = null; endHold() }}
        onPointerDown={(event) => {
          event.preventDefault() // stop the drag turning into a text selection
          event.currentTarget.setPointerCapture?.(event.pointerId)
          const x = localX(event.clientX, event.clientY)
          if (x === null) return
          pointersRef.current.set(event.pointerId, x)
          if (pointersRef.current.size === 2) {
            pinchRef.current = { ...twoFingers(), span: span ?? total, offset }
            dragRef.current = null
            setActiveIndex(null)
          } else if (pointersRef.current.size === 1) {
            if (event.pointerType === 'touch') {
              // show the point straight away, without needing a drag first
              setActiveIndex(indexFromLocalX(x))
              if (scrollable) return
              touchStartRef.current = x
              const startOffset = offset
              holdTimerRef.current = window.setTimeout(() => {
                holdRef.current = { x, offset: startOffset }
                holdTimerRef.current = null
                setHolding(true)
                setActiveIndex(null)
                navigator.vibrate?.(12)
              }, 320)
            } else {
              dragRef.current = { x, offset }
            }
          }
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture?.(event.pointerId)
          pointersRef.current.delete(event.pointerId)
          if (pointersRef.current.size < 2) pinchRef.current = null
          dragRef.current = null
          endHold()
        }}
        onPointerCancel={(event) => {
          pointersRef.current.delete(event.pointerId)
          if (pointersRef.current.size < 2) pinchRef.current = null
          dragRef.current = null
          endHold()
        }}
      >
        <svg ref={svgRef} className={`annual-chart ${compact ? 'compact' : ''}`} style={scrollable ? { width: `${width}px`, height: `${height}px`, maxWidth: 'none', flex: '0 0 auto' } : undefined} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Income, expenses, investments and net worth, ${rangeLabel}`}>
          {!scrollable && <text className="axis-caption" x={padding.left} y={padding.top - 16}>Money flow (RM)</text>}
          {!scrollable && <text className="axis-caption axis-caption-worth" x={width - padding.right} y={padding.top - 16} textAnchor="end">Net worth (RM)</text>}
          {[0, .25, .5, .75, 1].map((line) => {
            const gridY = base - line * plotHeight
            return <g key={line}>
              <line x1={padding.left} y1={gridY} x2={width - padding.right} y2={gridY} stroke="#e2e8ee" strokeWidth="1" />
              {!scrollable && <text x={padding.left - 12} y={gridY + 4} textAnchor="end">{Math.round((flowMax * line) / 1000)}k</text>}
              {!scrollable && <text className="axis-worth-tick" x={width - padding.right + 12} y={gridY + 4}>{Math.round((worthMax * line) / 1000)}k</text>}
            </g>
          })}
          <path className="income-area" d={`${flowPath('income')} L ${xFor(chartPoints.length - 1)} ${base} L ${xFor(0)} ${base} Z`} />
          {worthSegments.filter((segment) => segment.length > 1).map((segment, index) => <path key={`worth-${index}`} className="worth-path" d={smoothPath(segment)} />)}
          {flowSeries.map((series) => <path key={series.key} className="flow-path" d={flowPath(series.key)} stroke={series.color} />)}
          {chartPoints.map((point, index) => point.worth === null ? null : <circle key={`worth-dot-${point.key}`} className="worth-dot" cx={xFor(index)} cy={yWorth(point.worth)} r={chartPoints.length > 24 ? 3 : 5} />)}
          {chartPoints.map((point, index) => index % labelEvery === 0
            ? <text key={`label-${point.key}`} x={xFor(index)} y={height - 18} textAnchor="middle" className="annual-year-label">{point.label}</text>
            : null)}
          {active && <>
            <line className="annual-crosshair" x1={activeX} y1={padding.top} x2={activeX} y2={base} />
            {flowSeries.map((series) => <circle key={`active-${series.key}`} className="active-dot" cx={activeX} cy={yFlow(active[series.key])} r="5.5" stroke={series.color} />)}
            {active.worth !== null && <circle className="active-worth-dot" cx={activeX} cy={yWorth(active.worth)} r="6" />}
            <g className="annual-tooltip" pointerEvents="none">
              <rect className="annual-tooltip-shadow" x={tooltipX + 4} y={padding.top + 4} width={tooltipWidth} height={tooltipHeight} rx="12" />
              <rect className="annual-tooltip-card" x={tooltipX} y={padding.top} width={tooltipWidth} height={tooltipHeight} rx="12" />
              <text className="annual-tooltip-year" x={tooltipX + 12} y={padding.top + row + 2}>{active.label}</text>
              <text x={tooltipX + 12} y={padding.top + row * 2 + 5}>Income <tspan x={tooltipX + tooltipWidth - 12} textAnchor="end">{formatCurrency(active.income)}</tspan></text>
              <text x={tooltipX + 12} y={padding.top + row * 3 + 5}>Expenses <tspan x={tooltipX + tooltipWidth - 12} textAnchor="end">{formatCurrency(active.expenses)}</tspan></text>
              <text x={tooltipX + 12} y={padding.top + row * 4 + 5}>Invested <tspan x={tooltipX + tooltipWidth - 12} textAnchor="end">{formatCurrency(active.investments)}</tspan></text>
              {active.worth !== null && <text className="annual-tooltip-worth" x={tooltipX + 12} y={padding.top + row * 5 + 5}>Net worth <tspan x={tooltipX + tooltipWidth - 12} textAnchor="end">{formatCurrency(active.worth)}</tspan></text>}
            </g>
          </>}
        </svg>
      </div>
      {scrollable && <>
        <div className="axis-overlay left" style={{ height: `${height}px`, width: `${padding.left}px` }} aria-hidden="true">
          <b style={{ top: `${padding.top - 16}px` }}>RM</b>
          {[0, .25, .5, .75, 1].map((line) => <span key={line} style={{ top: `${base - line * plotHeight}px` }}>{Math.round((flowMax * line) / 1000)}k</span>)}
        </div>
        <div className="axis-overlay right" style={{ height: `${height}px`, width: `${padding.right}px` }} aria-hidden="true">
          <b style={{ top: `${padding.top - 16}px` }}>worth</b>
          {[0, .25, .5, .75, 1].map((line) => <span key={line} style={{ top: `${base - line * plotHeight}px` }}>{Math.round((worthMax * line) / 1000)}k</span>)}
        </div>
      </>}
      </div>
      <p className="chart-interaction-hint">{monthly ? 'Monthly view' : 'Yearly view'} · {rangeLabel} · scroll or pinch to zoom, hold and drag to pan, tap or hover for a point. Net worth uses the right axis.</p>
    </div>
  )

  return <>
    {!expanded && chartBody}
    <dialog className="chart-dialog" ref={dialogRef} onClose={() => setExpanded(false)} onCancel={() => setExpanded(false)}>
      {expanded && chartBody}
    </dialog>
  </>
}

function YearSparkline({ points }: { points: AnnualSummary['assetTrend'] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (points.length < 2) return <div className="sparkline-empty" />
  const width = 280
  const height = 78
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spread = max - min || 1
  const coords = points.map((point, index) => ({
    point,
    xPercent: (index / (points.length - 1)) * 100,
    yPercent: ((height - 4 - ((point.value - min) / spread) * (height - 8)) / height) * 100,
  }))
  const path = smoothPath(coords.map((coord) => ({ x: (coord.xPercent / 100) * width, y: (coord.yPercent / 100) * height })))
  const active = activeIndex === null ? null : coords[activeIndex]

  // the svg is stretched with preserveAspectRatio="none", so read the pointer against
  // the rendered box rather than the viewBox, and draw the marker/readout in HTML
  const trackPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width === 0) return
    const ratio = (event.clientX - bounds.left) / bounds.width
    setActiveIndex(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))))
  }

  return <div
    className="year-sparkline-wrap"
    onPointerMove={trackPointer}
    onPointerDown={trackPointer}
    onPointerLeave={() => setActiveIndex(null)}
    onPointerCancel={() => setActiveIndex(null)}
  >
    <svg className="year-sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Monthly closing worth from ${formatMonth(points[0].period)} to ${formatMonth(points.at(-1)!.period)}`}><path d={path} fill="none" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>
    {active && <>
      <span className="sparkline-marker" style={{ left: `${active.xPercent}%`, top: `${active.yPercent}%` }} aria-hidden="true" />
      <span
        className="sparkline-readout"
        style={{ left: `${active.xPercent}%`, transform: `translateX(${active.xPercent < 18 ? '0%' : active.xPercent > 82 ? '-100%' : '-50%'})` }}
        role="status"
      ><b>{formatShortMonth(active.point.period)}</b>{formatCurrency(active.point.value)}</span>
    </>}
  </div>
}

function LiquidAssetIndicator({
  period,
  assets,
  expenses,
  state,
  change,
}: {
  period: string
  assets: number
  expenses: number
  state: 'closed' | 'ongoing' | 'projected'
  change: number | null
}) {
  const value = assets - expenses
  const label = state === 'closed'
    ? 'Closing worth'
    : state === 'ongoing' ? 'Estimated current worth' : 'Projected worth'
  const shortLabel = state === 'ongoing' ? 'Est. current worth' : label

  return (
    <aside className={`liquid-indicator ${state}`} aria-label={`${label} for ${formatMonth(period)}: ${formatCurrency(value)}${change === null ? '' : `, ${changeLabel(change)} against the previous month's closing`}`}>
      <span className="liquid-indicator-icon" aria-hidden="true"><Wallet weight="duotone" /></span>
      <div className="liquid-indicator-body">
        <p><span className="label-long">{label}</span><span className="label-short">{shortLabel}</span>{state === 'ongoing' && <i className="live-dot" aria-hidden="true" />}</p>
        <div className="liquid-indicator-figure">
          <strong>{formatCurrency(value)}</strong>
          {change !== null && <span className={`change-pill ${change < 0 ? 'negative' : ''} ${state === 'ongoing' ? 'live' : ''}`}>{changeLabel(change)}</span>}
        </div>
      </div>
    </aside>
  )
}

function SecurityPanel({ userId, label }: { userId: string; label: string }) {
  const [pinSet, setPinSet] = useState(hasPin)
  const [biometricOn, setBiometricOn] = useState(hasBiometric)
  const [biometricReady, setBiometricReady] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { void biometricAvailable().then(setBiometricReady) }, [])

  const onlyDigits = (value: string) => value.replace(/\D/g, '').slice(0, 4)
  const reset = () => { setCurrent(''); setNext(''); setConfirm('') }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setMessage('')
    if (pinSet && !(await verifyPin(current))) return setError('That current PIN does not match.')
    if (next.length !== 4) return setError('The new PIN needs four digits.')
    if (next !== confirm) return setError('The two new PINs do not match.')
    await setPin(next)
    setPinSet(true)
    reset()
    setMessage('PIN saved. It is asked for each time the app opens.')
  }

  async function handleTurnOff() {
    setError('')
    setMessage('')
    if (!(await verifyPin(current))) return setError('Enter your current PIN to turn it off.')
    clearPin()
    setPinSet(false)
    setBiometricOn(false)
    reset()
    setMessage('PIN removed.')
  }

  async function handleBiometric() {
    setError('')
    setMessage('')
    if (biometricOn) {
      clearBiometric()
      setBiometricOn(false)
      return setMessage('Biometric unlock turned off.')
    }
    try {
      await registerBiometric(userId, label)
      setBiometricOn(true)
      setMessage('Biometric unlock is on. Your PIN still works as a fallback.')
    } catch (registerError) {
      setError(messageFrom(registerError))
    }
  }

  return (
    <section className="panel security-panel" aria-labelledby="security-title">
      <div className="security-intro">
        <p className="eyebrow">Security</p>
        <h2 id="security-title"><Lock weight="duotone" aria-hidden="true" />App lock</h2>
        <p>A 4-digit PIN asked for every time WorthDelta opens. It guards this device only — your data is still protected by your sign-in.</p>
      </div>
      <form className="security-form" onSubmit={(event) => void handleSave(event)}>
        {pinSet && <label><span>Current PIN</span><input value={current} onChange={(event) => setCurrent(onlyDigits(event.target.value))} type="password" inputMode="numeric" autoComplete="off" /></label>}
        <label><span>{pinSet ? 'New PIN' : 'PIN'}</span><input value={next} onChange={(event) => setNext(onlyDigits(event.target.value))} type="password" inputMode="numeric" autoComplete="off" /></label>
        <label><span>Confirm</span><input value={confirm} onChange={(event) => setConfirm(onlyDigits(event.target.value))} type="password" inputMode="numeric" autoComplete="off" /></label>
        <div className="security-actions">
          <button className="primary-action-button" type="submit">{pinSet ? 'Change PIN' : 'Turn on PIN'}</button>
          {pinSet && <button className="dialog-cancel-button" type="button" onClick={() => void handleTurnOff()}>Turn off</button>}
          {pinSet && biometricReady && <button className="dialog-cancel-button" type="button" onClick={() => void handleBiometric()}>{biometricOn ? 'Disable Face ID / fingerprint' : 'Use Face ID / fingerprint'}</button>}
        </div>
        {error && <p className="form-alert error" role="alert">{error}</p>}
        {message && <p className="notice" role="status">{message}</p>}
      </form>
    </section>
  )
}

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [pin, setPinValue] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const biometric = hasBiometric()

  const tryBiometric = useCallback(async () => {
    try {
      if (await verifyBiometric()) onUnlock()
    } catch {
      setError('Biometric unlock was cancelled. Enter your PIN.')
    }
  }, [onUnlock])

  // prompt once on open; onUnlock is a fresh closure each render, so guard it
  const promptedRef = useRef(false)
  useEffect(() => {
    if (!biometric || promptedRef.current) return
    promptedRef.current = true
    void tryBiometric()
  }, [biometric, tryBiometric])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (pin.length !== 4 || checking) return
    setChecking(true)
    if (await verifyPin(pin)) onUnlock()
    else {
      setError('That PIN does not match.')
      setPinValue('')
    }
    setChecking(false)
  }

  return (
    <main className="lock-screen">
      <form className="lock-card" onSubmit={(event) => void handleSubmit(event)}>
        <span className="brand-mark app-icon-mark" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}worthdelta-icon.png`} alt="" /></span>
        <h1>WorthDelta is locked</h1>
        <p>Enter your 4-digit PIN to continue.</p>
        <input
          className="lock-input"
          value={pin}
          onChange={(event) => {
            setPinValue(event.target.value.replace(/\D/g, '').slice(0, 4))
            setError('')
          }}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label="PIN"
          autoFocus
        />
        {error && <p className="form-alert error" role="alert">{error}</p>}
        <button className="primary-action-button" type="submit" disabled={pin.length !== 4 || checking}>Unlock</button>
        {biometric && <button className="lock-biometric" type="button" onClick={() => void tryBiometric()}>Use Face ID or fingerprint</button>}
      </form>
    </main>
  )
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
  const [repeatMonths, setRepeatMonths] = useState(1)
  const [currency, setCurrency] = useState('MYR')
  const [rate, setRate] = useState<number | null>(null)
  const [rateStamp, setRateStamp] = useState<string | null>(null)
  const [rateLive, setRateLive] = useState(false)
  const [rateLoading, setRateLoading] = useState(false)
  const [selectedCategoryEntries, setSelectedCategoryEntries] = useState<{ type: CategoryType; category: CategoryBreakdown; period: string } | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [categorySaving, setCategorySaving] = useState<CategoryType | null>(null)
  const [categoryEditSavingId, setCategoryEditSavingId] = useState<string | null>(null)
  const [entryEditSavingId, setEntryEditSavingId] = useState<string | null>(null)
  const [expenseGroupSavingId, setExpenseGroupSavingId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [newGroupIds, setNewGroupIds] = useState<Partial<Record<CategoryType, string>>>({})
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
      window.history.replaceState(null, '', '#records')
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

  const keepScrollPosition = useCallback(async <T,>(action: () => Promise<T>) => {
    const { scrollX, scrollY } = window
    const restore = () => window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' })
    try {
      return await action()
    } finally {
      restore()
      requestAnimationFrame(restore)
    }
  }, [])

  const groupsForType = (categoryType: CategoryType) => expenseGroups.filter((group) => group.category_type === categoryType)
  const categoryHistoryMonths = (category: FinancialCategory) => {
    const matchesName = (linked?: { name: string; category_type: CategoryType } | null) =>
      linked?.category_type === category.category_type &&
      linked.name.toLocaleLowerCase('en') === category.name.toLocaleLowerCase('en')
    const months = new Set<string>()
    records.forEach((record) => {
      if (Number(record.amount) > 0 && (record.category_id === category.id || matchesName(record.financial_categories))) months.add(record.period)
    })
    entries.forEach((entry) => {
      if (Number(entry.amount) > 0 && (entry.category_id === category.id || matchesName(entry.financial_categories))) months.add(entry.period)
    })
    return months.size
  }

  // last known rate first so the field works offline, then refresh it if we can
  useEffect(() => {
    if (currency === 'MYR') {
      setRate(null)
      setRateStamp(null)
      setRateLive(false)
      return
    }
    const cached = readCachedRate(currency)
    setRate(cached?.rate ?? null)
    setRateStamp(cached?.at ?? null)
    setRateLive(false)
    if (!navigator.onLine) return

    let cancelled = false
    setRateLoading(true)
    fetchMyrRate(currency)
      .then(({ rate: value }) => {
        if (cancelled) return
        writeCachedRate(currency, value)
        setRate(value)
        setRateStamp(new Date().toISOString())
        setRateLive(true)
      })
      .catch(() => undefined) // the cached or manual rate still stands
      .finally(() => { if (!cancelled) setRateLoading(false) })
    return () => { cancelled = true }
  }, [currency])

  const showSnapshot = useCallback((snapshot: { expense_groups: ExpenseGroup[]; categories: FinancialCategory[]; records: MonthlyRecord[]; entries: LedgerEntry[] }) => {
    setExpenseGroups(snapshot.expense_groups)
    setCategories(snapshot.categories)
    setRecords(snapshot.records)
    setEntries(snapshot.entries)
  }, [])

  useEffect(() => {
    setNewGroupIds((current) => {
      const next = { ...current }
      ;(['expense', 'asset'] as CategoryType[]).forEach((categoryType) => {
        const groups = expenseGroups.filter((group) => group.category_type === categoryType)
        if (!groups.some((group) => group.id === next[categoryType])) next[categoryType] = groups[0]?.id ?? ''
      })
      return next
    })
  }, [expenseGroups])

  const loadData = useCallback(async (showLoading = true, isRetry = false) => {
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

      await ensureFreshSession()

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
      // a token that lapsed in the background is worth one silent retry
      if (isExpiredTokenError(error) && !isRetry) {
        const { data } = await supabase.auth.refreshSession()
        if (data.session) return loadData(false, true)
      }
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
    // coming back to the app after a while is exactly when the token has lapsed
    const handleVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void loadData(false)
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    document.addEventListener('visibilitychange', handleVisible)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      document.removeEventListener('visibilitychange', handleVisible)
    }
  }, [loadData])

  const assetTrend = useMemo(() => {
    const totals = new Map<string, number>()
    records.filter((record) => record.financial_categories?.category_type === 'asset').forEach((record) => {
      totals.set(record.period, (totals.get(record.period) ?? 0) + Number(record.amount))
    })
    return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([pointPeriod, value]) => ({ period: pointPeriod, value }))
  }, [records])

  const monthlySeries = useMemo<MonthlyPoint[]>(() => {
    const totals = new Map<string, { income: number; expenses: number; investments: number; assets: number; hasAssets: boolean }>()
    records.forEach((record) => {
      const recordType = record.financial_categories?.category_type
      if (!recordType) return
      const bucket = totals.get(record.period) ?? { income: 0, expenses: 0, investments: 0, assets: 0, hasAssets: false }
      const value = Number(record.amount)
      if (recordType === 'income') bucket.income += value
      if (recordType === 'expense') bucket.expenses += value
      if (recordType === 'investment') bucket.investments += value
      if (recordType === 'asset') {
        bucket.assets += value
        bucket.hasAssets = true
      }
      totals.set(record.period, bucket)
    })
    const currentPeriod = getCurrentMonthPeriod()
    return [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([period]) => period <= currentPeriod)
      .map(([period, bucket]) => ({
        period,
        income: bucket.income,
        expenses: bucket.expenses,
        investments: bucket.investments,
        worth: bucket.hasAssets ? bucket.assets - bucket.expenses : null,
      }))
  }, [records])

  const annualSummaries = useMemo<AnnualSummary[]>(() => {
    const yearMap = new Map<number, {
      income: number
      expenses: number
      investments: number
      assets: Map<string, number>
      monthlyExpenses: Map<string, number>
    }>()

    records.forEach((record) => {
      const year = Number(record.period.slice(0, 4))
      if (!Number.isFinite(year)) return
      const summary = yearMap.get(year) ?? { income: 0, expenses: 0, investments: 0, assets: new Map<string, number>(), monthlyExpenses: new Map<string, number>() }
      const recordType = record.financial_categories?.category_type
      const value = Number(record.amount)
      if (recordType === 'income') summary.income += value
      if (recordType === 'expense') {
        summary.expenses += value
        summary.monthlyExpenses.set(record.period, (summary.monthlyExpenses.get(record.period) ?? 0) + value)
      }
      if (recordType === 'investment') summary.investments += value
      if (recordType === 'asset') summary.assets.set(record.period, (summary.assets.get(record.period) ?? 0) + value)
      yearMap.set(year, summary)
    })

    const currentPeriod = getCurrentMonthPeriod()
    return [...yearMap.entries()].sort(([a], [b]) => a - b).map(([year, summary]) => {
      const recordedAssets = [...summary.assets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([period]) => period <= currentPeriod)
      const yearlyAssetTrend = recordedAssets
        .map(([period, value]) => ({ period, value: value - (summary.monthlyExpenses.get(period) ?? 0) }))
      const netWorth = yearlyAssetTrend.at(-1)?.value ?? 0
      const openingWorth = recordedAssets[0]?.[1] ?? 0
      const result: AnnualSummary = {
        year,
        income: summary.income,
        expenses: summary.expenses,
        investments: summary.investments,
        netWorth,
        netWorthChange: netWorth - openingWorth,
        netWorthChangePercent: openingWorth ? ((netWorth - openingWorth) / Math.abs(openingWorth)) * 100 : null,
        monthsTracked: yearlyAssetTrend.length,
        savingsRate: summary.income ? ((summary.income - summary.expenses) / summary.income) * 100 : 0,
        assetTrend: yearlyAssetTrend,
      }
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
  const monthlyClosing = useMemo(() => {
    const totals = new Map<string, { assets: number; expenses: number }>()
    records.forEach((record) => {
      const recordType = record.financial_categories?.category_type
      if (recordType !== 'asset' && recordType !== 'expense') return
      const bucket = totals.get(record.period) ?? { assets: 0, expenses: 0 }
      bucket[recordType === 'asset' ? 'assets' : 'expenses'] += Number(record.amount)
      totals.set(record.period, bucket)
    })
    return new Map([...totals.entries()].map(([period, bucket]) => [period, bucket.assets - bucket.expenses]))
  }, [records])
  const currentYear = Number(getCurrentMonthPeriod().slice(0, 4))
  const overviewPreviousClosing = monthlyClosing.get(getPreviousMonthPeriod(activePeriod))
  const overviewChange = overviewPreviousClosing
    ? ((assets - expenses - overviewPreviousClosing) / Math.abs(overviewPreviousClosing)) * 100
    : null
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
      const sectionGroups = expenseGroups.filter((group) => group.category_type === sectionType)
      const groupOrder = new Map(sectionGroups.map((group, index) => [group.id, index]))
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
            archived: !!category.archived_at,
          }
        })
        .sort((a, b) => {
          if (sectionGroups.length > 0) {
            const groupDifference = (groupOrder.get(a.expenseGroupId ?? '') ?? sectionGroups.length) - (groupOrder.get(b.expenseGroupId ?? '') ?? sectionGroups.length)
            if (groupDifference !== 0) return groupDifference
          }
          return b.amount - a.amount || a.name.localeCompare(b.name)
        })
      return { type: sectionType, total, categories: breakdown.filter((entry) => !entry.archived || entry.amount > 0) }
    })
  }, [categories, expenseGroups, records, summaryPeriod])
  const liquidAssetTotal = recordSections.find((section) => section.type === 'asset')?.total ?? 0
  const monthExpenseTotal = recordSections.find((section) => section.type === 'expense')?.total ?? 0
  const currentMonthPeriod = getCurrentMonthPeriod()
  const liquidAssetState = summaryPeriod < currentMonthPeriod
    ? 'closed' as const
    : summaryPeriod === currentMonthPeriod ? 'ongoing' as const : 'projected' as const
  const showLiquidIndicator = liquidAssetTotal > 0 || monthExpenseTotal > 0

  const previousClosing = monthlyClosing.get(getPreviousMonthPeriod(summaryPeriod))
  const liquidAssetChange = previousClosing
    ? ((liquidAssetTotal - monthExpenseTotal - previousClosing) / Math.abs(previousClosing)) * 100
    : null

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

  async function saveLedgerEntry(entry: LedgerEntry, nextAmount: number, nextDescription: string) {
    if (!Number.isFinite(nextAmount) || nextAmount < 0) return false
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
    if (!categoryName.trim() || !entryDate || !amount) return
    const entered = Number(amount)
    const foreign = currency !== 'MYR'
    // a stale or missing rate still saves; syncPendingChanges converts it properly
    const needsRate = foreign && !rateLive
    const ringgit = foreign ? Number((entered * (rate ?? 0)).toFixed(2)) : entered
    const remark = [description.trim(), currency === 'MYR' ? '' : `(${currency} ${entered.toFixed(2)})`]
      .filter(Boolean)
      .join(' ')
    setSaving(true)
    setNotice('')

    try {
      let queued
      for (let index = 0; index < repeatMonths; index += 1) {
        const date = addMonths(entryDate, index)
        queued = await queueLedgerEntry({
          userId: session.user.id,
          categoryType: type,
          categoryName,
          categorySortOrder: categories.length + 1,
          period: `${date.slice(0, 7)}-01`,
          entryDate: date,
          amount: ringgit,
          description: remark,
          currency: foreign ? currency : null,
          originalAmount: foreign ? entered : null,
          needsRate,
        })
      }
      if (!queued) return
      showSnapshot(queued.snapshot)
      setPendingCount(queued.pendingCount)
      setAmount('')
      setDescription('')
      setRepeatMonths(1)
      setCurrency('MYR')
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
      setNotice(repeatMonths > 1 ? `Saved across ${repeatMonths} months and synced.` : 'Entry saved and synced.')
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
    setRepeatMonths(1)
    setCurrency('MYR')
    setEntryDate(defaultEntryDate(summaryPeriod))
    setType(nextType)
    setCategoryName(categories.find((category) => category.category_type === nextType)?.name ?? '')
    setAddMenuOpen(false)
    setEntryDialogOpen(true)
  }

  async function handleAddCategory(event: React.FormEvent, categoryType: CategoryType) {
    event.preventDefault()
    const categoryNameValue = newCategoryNames[categoryType].trim()
    if (!categoryNameValue) return
    const typeGroups = groupsForType(categoryType)
    if (typeGroups.length > 0 && !newGroupIds[categoryType]) {
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
        expenseGroupId: typeGroups.length > 0 ? newGroupIds[categoryType] ?? null : null,
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

  async function saveCategory(category: FinancialCategory, nextName: string, nextExpenseGroupId: string | null) {
    const trimmedName = nextName.trim()
    if (!trimmedName) return false
    if (groupsForType(category.category_type).length > 0 && !expenseGroups.some((group) => group.id === nextExpenseGroupId)) {
      setNotice('Choose a valid main group before saving this category.')
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
          expense_group_id: groupsForType(category.category_type).length > 0 ? nextExpenseGroupId : null,
        })
        .eq('id', category.id)
        .eq('user_id', session.user.id)
      if (error) throw error

      setCategories((current) => current.map((item) => item.id === category.id
        ? { ...item, name: trimmedName, expense_group_id: groupsForType(category.category_type).length > 0 ? nextExpenseGroupId : null }
        : item))

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

  async function saveExpenseGroup(group: ExpenseGroup, nextName: string) {
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

      setExpenseGroups((current) => current.map((item) => item.id === group.id ? { ...item, name: trimmedName } : item))

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

  async function handleExport() {
    setExporting(true)
    setNotice('')
    try {
      const chartImage = await captureChartImage()
      await downloadWorkbook({ categories, groups: expenseGroups, records, entries, chartImage })
      setNotice('Spreadsheet exported.')
    } catch (error) {
      setNotice(messageFrom(error))
    } finally {
      setExporting(false)
    }
  }

  async function removeLedgerEntry(entry: LedgerEntry) {
    if (!navigator.onLine) {
      setNotice('Reconnect to delete an entry.')
      return false
    }
    setEntryEditSavingId(entry.id)
    setSyncStatus('syncing')
    setNotice('')
    try {
      await syncPendingChanges(session.user.id)
      const { error } = await supabase
        .from('worthdelta_ledger_entries')
        .delete()
        .eq('id', entry.id)
        .eq('user_id', session.user.id)
      if (error) throw error

      // the monthly total is stored separately, so take the amount off it too
      const monthly = records.find((record) =>
        record.period === entry.period &&
        record.financial_categories?.category_type === entry.financial_categories?.category_type &&
        record.financial_categories?.name.toLocaleLowerCase('en') === entry.financial_categories?.name.toLocaleLowerCase('en'),
      )
      if (monthly) {
        const nextAmount = Math.max(0, Number(monthly.amount) - Number(entry.amount))
        const { error: recordError } = await supabase
          .from('worthdelta_monthly_records')
          .update({ amount: nextAmount })
          .eq('id', monthly.id)
          .eq('user_id', session.user.id)
        if (recordError) throw recordError
      }

      setEntries((current) => current.filter((item) => item.id !== entry.id))
      const remote = await refreshRemoteSnapshot(session.user.id)
      showSnapshot(remote.snapshot)
      setPendingCount(remote.pendingCount)
      setSyncStatus(remote.pendingCount > 0 ? 'pending' : 'synced')
      setLoadError('')
      setNotice('Entry deleted.')
      return true
    } catch (error) {
      setSyncStatus(navigator.onLine ? 'pending' : 'offline')
      setNotice(messageFrom(error))
      return false
    } finally {
      setEntryEditSavingId(null)
    }
  }

  async function removeCategory(category: FinancialCategory) {
    if (!navigator.onLine) {
      setNotice('Reconnect to remove a category.')
      return false
    }
    const keepsHistory = categoryHistoryMonths(category) > 0
    setCategoryEditSavingId(category.id)
    setSyncStatus('syncing')
    setNotice('')
    try {
      await syncPendingChanges(session.user.id)
      const query = supabase.from('worthdelta_financial_categories')
      const { error } = keepsHistory
        ? await query.update({ archived_at: new Date().toISOString() }).eq('id', category.id).eq('user_id', session.user.id)
        : await query.delete().eq('id', category.id).eq('user_id', session.user.id)
      if (error) throw error

      setCategories((current) => keepsHistory
        ? current.map((item) => item.id === category.id ? { ...item, archived_at: new Date().toISOString() } : item)
        : current.filter((item) => item.id !== category.id))

      const remote = await refreshRemoteSnapshot(session.user.id)
      showSnapshot(remote.snapshot)
      setPendingCount(remote.pendingCount)
      setSyncStatus(remote.pendingCount > 0 ? 'pending' : 'synced')
      setLoadError('')
      setNotice(keepsHistory
        ? `${category.name} archived. Past months keep their amounts.`
        : `${category.name} deleted.`)
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

  const handleDeleteCategory = (category: FinancialCategory) => keepScrollPosition(() => removeCategory(category))
  const handleDeleteLedgerEntry = (entry: LedgerEntry) => keepScrollPosition(() => removeLedgerEntry(entry))
  const handleUpdateLedgerEntry = (entry: LedgerEntry, nextAmount: number, nextDescription: string) =>
    keepScrollPosition(() => saveLedgerEntry(entry, nextAmount, nextDescription))
  const handleUpdateCategory = (category: FinancialCategory, nextName: string, nextExpenseGroupId: string | null) =>
    keepScrollPosition(() => saveCategory(category, nextName, nextExpenseGroupId))
  const handleUpdateExpenseGroup = (group: ExpenseGroup, nextName: string) =>
    keepScrollPosition(() => saveExpenseGroup(group, nextName))

  const filteredCategories = categories.filter((category) => category.category_type === type && !category.archived_at)
  const typeGroupList = groupsForType(type)
  const ungroupedTypeCategories = typeGroupList.length > 0
    ? filteredCategories.filter((category) => !typeGroupList.some((group) => group.id === category.expense_group_id))
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
          <article><span><span className="label-long">Estimated current worth</span><span className="label-short">Est. current worth</span>{activePeriod === currentMonthPeriod && <i className="live-dot" aria-hidden="true" />}</span><strong>{formatCurrency(assets - expenses)}{overviewChange !== null && <span className={`change-pill ${overviewChange < 0 ? 'negative' : ''} ${activePeriod === currentMonthPeriod ? 'live' : ''}`}>{changeLabel(overviewChange)}</span>}</strong><small>{formatMonth(activePeriod)}</small></article>
          <article><span>Monthly income</span><strong>{formatCurrency(income)}</strong><small>{formatMonth(activePeriod)}</small></article>
          <article><span>Monthly expenses</span><strong>{formatCurrency(expenses)}</strong><small>{income ? `${Math.round((expenses / income) * 100)}% of income` : formatMonth(activePeriod)}</small></article>
          <article><span>Invested</span><strong>{formatCurrency(investments)}</strong><small>{formatMonth(activePeriod)}</small></article>
        </section>

        <section className="panel annual-panel">
          <div className="panel-heading annual-heading"><div><p className="eyebrow">Annual overview</p><h2>Your financial progress</h2><p>Income, spending, investing, and net worth by year. The current year shows where it stands today.</p></div><span className="annual-range">{annualSummaries[0]?.year ?? '—'}–{annualSummaries.at(-1)?.year ?? '—'}</span></div>
          {loading ? <div className="loading-state"><SpinnerGap className="spin" aria-hidden="true" />Loading annual progress…</div> : <AnnualChart points={monthlySeries} />}
        </section>

        <section className="year-progress-section" aria-labelledby="year-progress-title">
          <div className="section-heading"><div><p className="eyebrow">Year by year</p><h2 id="year-progress-title">Progress cards</h2></div><p>Each year settles on its last recorded month, after that month's spending. The current year stays live.</p></div>
          <div className="year-progress-grid">{[...annualSummaries].reverse().map((year) => <article className="year-card" key={year.year}>
            <div className="year-card-heading"><div><span>{year.year}</span><strong>{formatCurrency(year.netWorth)}</strong><small>{year.year === currentYear ? 'Current worth' : 'Closing worth'}</small></div><span className={`year-change ${year.netWorthChange < 0 ? 'negative' : ''}`}>{year.netWorthChange >= 0 ? '+' : ''}{formatCurrency(year.netWorthChange)}{year.netWorthChangePercent !== null && <small>{changeLabel(year.netWorthChangePercent)}</small>}</span></div>
            <YearSparkline points={year.assetTrend} />
            <dl><div><dt>Income</dt><dd>{formatCurrency(year.income)}</dd></div><div><dt>Expenses</dt><dd>{formatCurrency(year.expenses)}</dd></div><div><dt>Invested</dt><dd>{formatCurrency(year.investments)}{year.income > 0 && <span className="dd-ratio">({Math.round((year.investments / year.income) * 100)}%)</span>}</dd></div><div><dt>Savings rate</dt><dd>{Math.round(year.savingsRate)}%</dd></div></dl>
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
          {recordSections.map((section) => <RecordSectionCard key={section.type} type={section.type} period={summaryPeriod} total={section.total} categories={section.categories} expenseGroups={groupsForType(section.type)} onOpenCategory={(sectionType, category) => setSelectedCategoryEntries({ type: sectionType, category, period: summaryPeriod })} />)}
        </section>}
        </> : <>
        <section className="category-settings-grid" aria-label="Financial category settings">
          {(Object.keys(categoryMeta) as CategoryType[]).map((categoryType) => {
            const meta = categoryMeta[categoryType]
            const Icon = meta.icon
            const sectionCategories = categories.filter((category) => category.category_type === categoryType && !category.archived_at)
            const settingsGroups = groupsForType(categoryType)
            const unassignedSettingsCategories = settingsGroups.length > 0
              ? sectionCategories.filter((category) => !settingsGroups.some((group) => group.id === category.expense_group_id))
              : []
            return <article className={`category-settings-card ${categoryType}`} key={categoryType}>
              <header><span className={`record-section-icon ${categoryType}`}><Icon weight="duotone" aria-hidden="true" /></span><div><h2>{meta.label}</h2><p>{sectionCategories.length} {sectionCategories.length === 1 ? 'category' : 'categories'}</p></div></header>
              <form className={`category-add-form ${settingsGroups.length > 0 ? 'with-group' : ''}`} onSubmit={(event) => void handleAddCategory(event, categoryType)}>
                <label><span className="sr-only">New {meta.label.toLocaleLowerCase('en')} category</span><input value={newCategoryNames[categoryType]} onChange={(event) => setNewCategoryNames((current) => ({ ...current, [categoryType]: event.target.value }))} placeholder={`New ${meta.label.toLocaleLowerCase('en')} category`} maxLength={80} required /></label>
                {settingsGroups.length > 0 && <label><span className="sr-only">Main group for new {meta.label.toLocaleLowerCase('en')} category</span><select value={newGroupIds[categoryType] ?? ''} onChange={(event) => setNewGroupIds((current) => ({ ...current, [categoryType]: event.target.value }))} required><option value="" disabled>Choose group</option>{settingsGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
                <button type="submit" disabled={categorySaving !== null || (settingsGroups.length > 0 && !newGroupIds[categoryType])}>{categorySaving === categoryType ? <SpinnerGap className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}Add</button>
              </form>
              {settingsGroups.length > 0 ? <div className="expense-settings-groups">
                {settingsGroups.map((group, groupIndex) => {
                  const groupCategories = sectionCategories.filter((category) => category.expense_group_id === group.id)
                  return <section className={`expense-settings-group tone-${groupIndex % 2}`} key={group.id}>
                    <header><ExpenseGroupEditor group={group} saving={expenseGroupSavingId === group.id} onSave={(name) => handleUpdateExpenseGroup(group, name)} /><span>{groupCategories.length} {groupCategories.length === 1 ? 'category' : 'categories'}</span></header>
                    {groupCategories.length === 0 ? <p className="expense-group-empty">No categories assigned.</p> : <div className="category-chip-list">{groupCategories.map((category) => <CategoryEditor key={category.id} category={category} expenseGroups={settingsGroups} saving={categoryEditSavingId === category.id} onSave={(name, expenseGroupId) => handleUpdateCategory(category, name, expenseGroupId)} onDelete={() => handleDeleteCategory(category)} historyMonths={categoryHistoryMonths(category)} />)}</div>}
                  </section>
                })}
                {unassignedSettingsCategories.length > 0 && <section className="expense-settings-group unassigned"><header><strong>Unassigned</strong><span>{unassignedSettingsCategories.length} categories</span></header><div className="category-chip-list">{unassignedSettingsCategories.map((category) => <CategoryEditor key={category.id} category={category} expenseGroups={settingsGroups} saving={categoryEditSavingId === category.id} onSave={(name, expenseGroupId) => handleUpdateCategory(category, name, expenseGroupId)} onDelete={() => handleDeleteCategory(category)} historyMonths={categoryHistoryMonths(category)} />)}</div></section>}
              </div> : sectionCategories.length === 0 ? <p className="settings-empty">No categories here yet.</p> : <div className="category-chip-list section-category-chips">{sectionCategories.map((category) => <CategoryEditor key={category.id} category={category} expenseGroups={settingsGroups} saving={categoryEditSavingId === category.id} onSave={(name, expenseGroupId) => handleUpdateCategory(category, name, expenseGroupId)} onDelete={() => handleDeleteCategory(category)} historyMonths={categoryHistoryMonths(category)} />)}</div>}
            </article>
          })}
        </section>
        <section className="panel export-panel" aria-labelledby="export-title">
          <div><p className="eyebrow">Spreadsheet</p><h2 id="export-title">Export to Excel</h2><p>One sheet per year with your months as live formulas — each cell keeps its parts, like <code>=12.5+30+8</code> — plus totals, worth change, savings rate and a snapshot of the annual chart.</p></div>
          <button className="primary-action-button" type="button" onClick={() => void handleExport()} disabled={exporting || records.length === 0}>{exporting ? <SpinnerGap className="spin" aria-hidden="true" /> : <DownloadSimple aria-hidden="true" />}{exporting ? 'Building…' : 'Download .xlsx'}</button>
        </section>
        <SecurityPanel userId={session.user.id} label={session.user.email ?? 'WorthDelta user'} />
        </>}

        {view === 'records' && <>
          {!loading && showLiquidIndicator && <LiquidAssetIndicator period={summaryPeriod} assets={liquidAssetTotal} expenses={monthExpenseTotal} state={liquidAssetState} change={liquidAssetChange} />}
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
            <header className="entry-dialog-heading"><div><h2 id="entry-dialog-title">Add a new entry</h2></div><button type="button" onClick={() => setEntryDialogOpen(false)} aria-label="Close add entry form"><X aria-hidden="true" /></button></header>
            <form onSubmit={handleSave}>
              <div className={`entry-type-badge ${type}`}><EntryTypeIcon weight="duotone" aria-hidden="true" /><span>{categoryMeta[type].label}</span></div>
              <label><span>Category</span><select value={categoryName} onChange={(event) => setCategoryName(event.target.value)} required><option value="" disabled>{filteredCategories.length ? 'Choose a category' : 'Add a category in Settings first'}</option>{typeGroupList.length > 0 ? <>
                {typeGroupList.map((group) => { const groupCategories = filteredCategories.filter((category) => category.expense_group_id === group.id); return groupCategories.length > 0 ? <optgroup key={group.id} label={group.name}>{groupCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</optgroup> : null })}
                {ungroupedTypeCategories.length > 0 && <optgroup label="Unassigned">{ungroupedTypeCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</optgroup>}
              </> : filteredCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label>
              {filteredCategories.length === 0 && <a className="dialog-settings-link" href="#settings" onClick={() => setEntryDialogOpen(false)}><GearSix aria-hidden="true" />Open category settings</a>}
              <label><span>Remark</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What did you buy?" maxLength={200} /></label>
              <div className="form-row"><label><span>Date</span><input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required /></label><label><span>Amount</span><div className="amount-field"><select value={currency} onChange={(event) => setCurrency(event.target.value)} aria-label="Currency">{CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</select><input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required /></div></label></div>
              {currency !== 'MYR' && <p className={`rate-hint ${rate && !rateLive ? 'stale' : ''}`} role="status">{rateLoading && !rate
                ? 'Fetching today’s rate…'
                : !rate
                  ? `Saved in ${currency} — it converts to MYR on the next sync.`
                  : rateLive
                    ? `${formatCurrency(Number(amount || 0) * rate)} at 1 ${currency} = ${rate.toFixed(4)} MYR`
                    : `About ${formatCurrency(Number(amount || 0) * rate)} at ${rateStamp ? formatEntryDate(rateStamp) : 'an older'} rate — reconverted on sync.`}</p>}
              <label className="repeat-field"><span>Repeat</span><select value={repeatMonths} onChange={(event) => setRepeatMonths(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => index + 1).map((months) => <option key={months} value={months}>{months === 1 ? 'This month only' : `${months} months — through ${formatMonth(`${addMonths(entryDate, months - 1).slice(0, 7)}-01`)}`}</option>)}</select></label>
              <div className="entry-dialog-actions"><button className="dialog-cancel-button" type="button" onClick={() => setEntryDialogOpen(false)}>Cancel</button><button className="primary-action-button" type="submit" disabled={saving || !!loadError || filteredCategories.length === 0}>{saving ? <SpinnerGap className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}Save entry</button></div>
            </form>
          </div>
        </dialog>

        <dialog className="entry-dialog category-entries-dialog" ref={categoryEntriesDialogRef} aria-labelledby="category-entries-title" onClose={() => setSelectedCategoryEntries(null)} onCancel={() => setSelectedCategoryEntries(null)} onClick={(event) => { if (event.target === event.currentTarget) setSelectedCategoryEntries(null) }}>
          {selectedCategoryEntries && selectedCategorySummary && <div className="entry-dialog-card category-entries-card">
            <header className="entry-dialog-heading"><div><p className="eyebrow">{categoryMeta[selectedCategoryEntries.type].label} · {formatMonth(selectedCategoryEntries.period)}</p><h2 id="category-entries-title">{selectedCategorySummary.name}</h2><p>{categoryLedgerEntries.length} {categoryLedgerEntries.length === 1 ? 'entry' : 'entries'} · {formatCurrency(selectedCategorySummary.amount)} category total</p></div><button type="button" onClick={() => setSelectedCategoryEntries(null)} aria-label="Close category entries"><X aria-hidden="true" /></button></header>
            <div className={`entry-type-badge ${selectedCategoryEntries.type}`}><SelectedCategoryIcon weight="duotone" aria-hidden="true" /><span>Amount and remark details</span></div>
            {categoryLedgerEntries.length === 0 ? <div className="category-entry-empty"><Receipt aria-hidden="true" /><strong>No itemised entries for this month</strong><p>The category total exists, but no amount-and-remark breakdown is available.</p></div> : <div className="category-entry-list">{categoryLedgerEntries.map((entry) => <EditableLedgerEntryRow key={entry.id} entry={entry} saving={entryEditSavingId === entry.id} onSave={handleUpdateLedgerEntry} onDelete={handleDeleteLedgerEntry} />)}</div>}
          </div>}
        </dialog>
      </main>
    </div>
  )
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  // a PIN, once set, is asked for every time the app is opened
  const [locked, setLocked] = useState(hasPin)

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setLoading(false) })
    return () => data.subscription.unsubscribe()
  }, [])

  if (loading) return <main className="boot-screen"><span className="brand-mark" aria-hidden="true">Δ</span><SpinnerGap className="spin" aria-label="Loading WorthDelta" /></main>
  if (!session) return <HubRedirect />
  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />
  return <Dashboard session={session} />
}

export default App
