/**
 * Live rate into MYR, tried against three independent free sources.
 *
 * Order matters. The first two agreed to within 0.01% when this was written and
 * both track mid-market, which is what Google quotes; the third sat about 0.5%
 * away, so it is a last resort rather than a peer. It earns its place by covering
 * currencies the others miss (TWD, VND, AED, crypto) and by being served from a
 * CDN, so it tends to survive when an API host does not.
 */

interface RateSource {
  name: string
  url: (code: string) => string
  read: (payload: unknown, code: string) => number | undefined
}

const SOURCES: RateSource[] = [
  {
    name: 'exchangerate-api',
    url: (code) => `https://open.er-api.com/v6/latest/${code}`,
    read: (payload) => (payload as { rates?: Record<string, number> })?.rates?.MYR,
  },
  {
    name: 'frankfurter',
    url: (code) => `https://api.frankfurter.dev/v1/latest?base=${code}&symbols=MYR`,
    read: (payload) => (payload as { rates?: Record<string, number> })?.rates?.MYR,
  },
  {
    name: 'currency-api',
    url: (code) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${code.toLowerCase()}.json`,
    read: (payload, code) => (payload as Record<string, Record<string, number>>)?.[code.toLowerCase()]?.myr,
  },
]

export interface RateResult {
  rate: number
  source: string
}

export async function fetchMyrRate(code: string): Promise<RateResult> {
  if (code === 'MYR') return { rate: 1, source: 'none' }
  const failures: string[] = []

  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url(code))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value = source.read(await response.json(), code)
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('no MYR rate')
      return { rate: value, source: source.name }
    } catch (error) {
      failures.push(`${source.name} (${error instanceof Error ? error.message : 'failed'})`)
    }
  }

  throw new Error(`No exchange rate for ${code}. Tried ${failures.join(', ')}.`)
}
