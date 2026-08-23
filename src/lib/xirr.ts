export interface DatedCashFlow {
  date: string
  amount: number
}

const DAY_MS = 86_400_000
const MIN_RATE = -0.999999999
const MAX_RATE = 1_000_000

const utcDay = (date: string) => {
  const [year, month, day] = date.slice(0, 10).split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

export function combineCashFlowsByDate(cashFlows: DatedCashFlow[]) {
  const totals = new Map<string, number>()
  cashFlows.forEach(({ date, amount }) => {
    if (!Number.isFinite(amount) || !date) return
    const day = date.slice(0, 10)
    totals.set(day, (totals.get(day) ?? 0) + amount)
  })
  return [...totals.entries()]
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function xnpv(rate: number, cashFlows: DatedCashFlow[]) {
  if (rate <= -1) return Number.NaN
  const firstDay = utcDay(cashFlows[0].date)
  return cashFlows.reduce((total, flow) => {
    const years = (utcDay(flow.date) - firstDay) / DAY_MS / 365
    return total + flow.amount / Math.pow(1 + rate, years)
  }, 0)
}

function xnpvDerivative(rate: number, cashFlows: DatedCashFlow[]) {
  if (rate <= -1) return Number.NaN
  const firstDay = utcDay(cashFlows[0].date)
  return cashFlows.reduce((total, flow) => {
    const years = (utcDay(flow.date) - firstDay) / DAY_MS / 365
    if (years === 0) return total
    return total - (years * flow.amount) / Math.pow(1 + rate, years + 1)
  }, 0)
}

function bisect(cashFlows: DatedCashFlow[], low: number, high: number) {
  let lowValue = xnpv(low, cashFlows)
  for (let iteration = 0; iteration < 160; iteration += 1) {
    const middle = (low + high) / 2
    const middleValue = xnpv(middle, cashFlows)
    if (!Number.isFinite(middleValue)) return null
    if (Math.abs(middleValue) < 0.000001 || Math.abs(high - low) < 0.000000001) return middle
    if (Math.sign(lowValue) === Math.sign(middleValue)) {
      low = middle
      lowValue = middleValue
    } else {
      high = middle
    }
  }
  return (low + high) / 2
}

/**
 * Returns an annual decimal rate (0.25 = 25%) or null when the dated flows do
 * not contain a solvable mix of money entering and leaving the investment.
 */
export function calculateXirr(input: DatedCashFlow[]) {
  const cashFlows = combineCashFlowsByDate(input).filter((flow) => Math.abs(flow.amount) > 0.000001)
  if (cashFlows.length < 2) return null
  if (!cashFlows.some((flow) => flow.amount < 0) || !cashFlows.some((flow) => flow.amount > 0)) return null
  if (cashFlows[0].date === cashFlows.at(-1)?.date) return null

  let rate = 0.1
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const value = xnpv(rate, cashFlows)
    const derivative = xnpvDerivative(rate, cashFlows)
    if (!Number.isFinite(value) || !Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) break
    if (Math.abs(value) < 0.000001) return rate
    const next = rate - value / derivative
    if (!Number.isFinite(next) || next <= MIN_RATE || next > MAX_RATE) break
    if (Math.abs(next - rate) < 1e-10) return next
    rate = next
  }

  const candidates = [
    MIN_RATE,
    -0.9999,
    -0.99,
    -0.9,
    -0.75,
    -0.5,
    -0.25,
    0,
    0.1,
    0.25,
    0.5,
    1,
    2,
    5,
    10,
    25,
    100,
    1_000,
    MAX_RATE,
  ]
  const roots: number[] = []
  for (let index = 0; index < candidates.length - 1; index += 1) {
    const low = candidates[index]
    const high = candidates[index + 1]
    const lowValue = xnpv(low, cashFlows)
    const highValue = xnpv(high, cashFlows)
    if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) continue
    if (Math.abs(lowValue) < 0.000001) roots.push(low)
    if (Math.sign(lowValue) !== Math.sign(highValue)) {
      const root = bisect(cashFlows, low, high)
      if (root !== null) roots.push(root)
    }
  }
  return roots.sort((a, b) => Math.abs(a - 0.1) - Math.abs(b - 0.1))[0] ?? null
}
