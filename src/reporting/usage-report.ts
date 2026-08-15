/**
 * Usage report computation — the single source of truth for every report
 * (TUI route, `usage` tool, CLI `stats`). One computation, many renderers.
 *
 * Cost model:
 *  - `cost.exact`       = sum of opencode's per-step cost (at time of use).
 *  - `cost.breakdown`   = recomputed from stored tokens with the best pricing
 *    available now (models.dev rows first, catalog fallback). NULL when a
 *    model has no pricing -> "Cost: Unknown" in renderers.
 *
 * Cache model:
 *  - Only events from providers known to report cache tokens contribute to
 *    hit-rate/savings. If no such events exist in the period, the report
 *    says "Cache data: Not available" — missing data is never treated as zero.
 */

import type { PricingProvider } from "../types/pricing.ts"
import type { ReportFilter, ReportPeriod, UsageReport } from "../types/usage.ts"
import { CostCalculator } from "../pricing/cost-calculator.ts"
import { UsageDatabase } from "../storage/database.ts"

export interface ReportOptions {
  pricing: PricingProvider
  now?: number
}

interface EventRow {
  provider: string | null
  model: string | null
  agent: string | null
  parent_session_id: string | null
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost: number | null
  provider_reported_cache: number
  timestamp: number
}

interface AggRow {
  provider: string | null
  model: string | null
  requests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  grossInput: number
  cost: number | null
}

const emptyAgg = (): AggRow => ({
  provider: null,
  model: null,
  requests: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  grossInput: 0,
  cost: null,
})

/** Resolve a period into (startMs, endMs) or (null, null) for "all". */
export function periodRange(period: ReportPeriod, now: number): { start: number | null; end: number | null } {
  switch (period.kind) {
    case "all":
      return { start: null, end: null }
    case "today": {
      const d = new Date(now)
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      return { start, end: null }
    }
    case "week":
      return { start: now - 7 * 24 * 3600_000, end: null }
    case "month":
      return { start: now - 30 * 24 * 3600_000, end: null }
    case "session":
      return { start: null, end: null }
  }
}

export function periodLabel(period: ReportPeriod): string {
  switch (period.kind) {
    case "session":
      return "Current Session"
    case "today":
      return "Today"
    case "week":
      return "Last 7 Days"
    case "month":
      return "Last 30 Days"
    case "all":
      return "All Time"
  }
}

export function computeReport(db: UsageDatabase, period: ReportPeriod, filter: ReportFilter = {}, options: ReportOptions): UsageReport {
  const now = options.now ?? Date.now()
  const { start, end } = periodRange(period, now)
  const where: string[] = []
  const params: Array<string | number | null> = []
  if (period.kind === "session") {
    where.push("e.session_id = ?")
    params.push(period.sessionId)
  }
  if (start !== null) {
    where.push("e.timestamp >= ?")
    params.push(start)
  }
  if (end !== null) {
    where.push("e.timestamp <= ?")
    params.push(end)
  }
  if (filter.provider) {
    where.push("e.provider LIKE ?")
    params.push(`%${filter.provider}%`)
  }
  if (filter.model) {
    where.push("e.model LIKE ?")
    params.push(`%${filter.model}%`)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const whereParams = [...params]

  // ---- usage events -------------------------------------------------------
  const eventRows = db.raw
    .prepare(
      `SELECT e.provider, e.model, e.agent, e.parent_session_id,
              e.input_tokens, e.output_tokens, e.reasoning_tokens,
              e.cache_read_tokens, e.cache_write_tokens, e.total_tokens,
              e.cost, e.provider_reported_cache, e.timestamp
       FROM usage_events e
       ${whereSql}`,
    )
    .all(...whereParams) as unknown as EventRow[]

  const totals = emptyAgg()
  const perModel = new Map<string, AggRow>()
  const perProvider = new Map<string, AggRow>()
  const cacheReportingEvents = { read: 0, write: 0, input: 0, count: 0 }
  let exactCost: number | null = null
  let largest: UsageReport["largestRequest"] = null
  let anyEvent = false

  for (const row of eventRows) {
    anyEvent = true
    totals.requests += 1
    totals.totalTokens += row.total_tokens
    totals.inputTokens += row.input_tokens
    totals.outputTokens += row.output_tokens
    totals.reasoningTokens += row.reasoning_tokens
    totals.cacheReadTokens += row.cache_read_tokens
    totals.cacheWriteTokens += row.cache_write_tokens
    totals.grossInput += row.input_tokens + row.cache_read_tokens + row.cache_write_tokens
    if (row.cost !== null && Number.isFinite(row.cost)) exactCost = (exactCost ?? 0) + row.cost

    if (row.provider_reported_cache === 1) {
      cacheReportingEvents.read += row.cache_read_tokens
      cacheReportingEvents.write += row.cache_write_tokens
      cacheReportingEvents.input += row.input_tokens
      cacheReportingEvents.count += 1
    }

    if (!largest || row.total_tokens > largest.totalTokens) {
      largest = {
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        provider: row.provider,
        model: row.model,
        timestamp: row.timestamp,
      }
    }

    const modelKey = `${row.provider ?? "unknown"}/${row.model ?? "unknown"}`
    let mRow = perModel.get(modelKey)
    if (!mRow) {
      mRow = emptyAgg()
      mRow.provider = row.provider
      mRow.model = row.model
      perModel.set(modelKey, mRow)
    }
    aggregateInto(mRow, row)

    const pKey = row.provider ?? "unknown"
    let pRow = perProvider.get(pKey)
    if (!pRow) {
      pRow = emptyAgg()
      pRow.provider = row.provider
      perProvider.set(pKey, pRow)
    }
    aggregateInto(pRow, row)
  }

  // ---- message / session counts -------------------------------------------
  const countSql = `SELECT COUNT(*) AS n FROM messages m WHERE 1=1 ${where.length ? `AND ${where.map((w) => w.replaceAll("e.", "m.")).join(" AND ")}` : ""}`
  const userMessages = (db.raw.prepare(`${countSql} AND m.role = 'user'`).get(...whereParams) as { n: number }).n
  const assistantMessages = (db.raw.prepare(`${countSql} AND m.role = 'assistant'`).get(...whereParams) as { n: number }).n

  const sessions = (() => {
    if (period.kind === "session") {
      return (db.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(period.sessionId) as { n: number }).n
    }
    const sessionWhere: string[] = []
    const sessionParams: Array<number | string> = []
    if (start !== null) {
      sessionWhere.push("created >= ?")
      sessionParams.push(start)
    }
    if (end !== null) {
      sessionWhere.push("created <= ?")
      sessionParams.push(end)
    }
    const sql = `SELECT COUNT(*) AS n FROM sessions ${sessionWhere.length ? `WHERE ${sessionWhere.join(" AND ")}` : ""}`
    return (db.raw.prepare(sql).get(...sessionParams) as { n: number }).n
  })()

  // ---- agent classification -------------------------------------------------
  const SYSTEM_AGENTS = new Set(["compaction", "title", "summary"])
  let mainAgentRequests = 0
  let subagentRequests = 0
  let systemRequests = 0
  for (const row of eventRows) {
    if (row.parent_session_id) {
      subagentRequests += 1
    } else if (row.agent && SYSTEM_AGENTS.has(row.agent)) {
      systemRequests += 1
    } else {
      mainAgentRequests += 1
    }
  }

  // ---- pricing-aware breakdown ----------------------------------------------
  const breakdown = { input: 0 as number | null, output: 0 as number | null, cacheRead: 0 as number | null, cacheWrite: 0 as number | null }
  let anyUnknown = false
  for (const row of eventRows) {
    const pricing = options.pricing.getPricing(row.provider ?? "unknown", row.model ?? "unknown", row.timestamp)
    const calc = CostCalculator.compute(
      {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens + row.reasoning_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
      },
      pricing,
    )
    if (calc.unknown) {
      anyUnknown = true
      breakdown.input = null
      breakdown.output = null
      breakdown.cacheRead = null
      breakdown.cacheWrite = null
      break
    }
    breakdown.input = (breakdown.input ?? 0) + (calc.input ?? 0)
    breakdown.output = (breakdown.output ?? 0) + (calc.output ?? 0)
    breakdown.cacheRead = (breakdown.cacheRead ?? 0) + (calc.cacheRead ?? 0)
    breakdown.cacheWrite = (breakdown.cacheWrite ?? 0) + (calc.cacheWrite ?? 0)
  }
  const costUnknown = anyEvent && anyUnknown
  const breakdownTotal = costUnknown
    ? null
    : (breakdown.input ?? 0) + (breakdown.output ?? 0) + (breakdown.cacheRead ?? 0) + (breakdown.cacheWrite ?? 0)

  // ---- cache metrics -----------------------------------------------------------
  const cacheAvailable = cacheReportingEvents.count > 0
  const hitRate =
    cacheAvailable && cacheReportingEvents.read + cacheReportingEvents.input > 0
      ? cacheReportingEvents.read / (cacheReportingEvents.read + cacheReportingEvents.input)
      : null
  // Estimated savings = cache reads at cache-read price (only when every
  // cache-reporting event has pricing for its model).
  let cacheSavings: number | null = null
  if (cacheAvailable) {
    let savingsTotal = 0
    let savingsKnown = true
    for (const row of eventRows) {
      if (row.provider_reported_cache !== 1 || row.cache_read_tokens <= 0) continue
      const pricing = options.pricing.getPricing(row.provider ?? "unknown", row.model ?? "unknown", row.timestamp)
      const readPrice = pricing?.cacheReadPricePerMillion ?? null
      if (readPrice === null) {
        savingsKnown = false
        break
      }
      savingsTotal += (row.cache_read_tokens / 1_000_000) * readPrice
    }
    cacheSavings = savingsKnown ? savingsTotal : null
  }

  // ---- top models ------------------------------------------------------------------
  const modelRows = [...perModel.values()]
    .map((row) => ({
      provider: row.provider ?? "unknown",
      model: row.model ?? "unknown",
      requests: row.requests,
      totalTokens: row.totalTokens,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cost: row.cost,
    }))
    .sort((a, b) => b.requests - a.requests)

  const providerRows = [...perProvider.values()]
    .map((row) => ({
      provider: row.provider ?? "unknown",
      requests: row.requests,
      totalTokens: row.totalTokens,
      cost: row.cost,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const costSortable = modelRows.filter((row) => row.cost !== null)
  const mostUsed = modelRows[0] ?? null
  const mostExpensive = costSortable.length
    ? costSortable.reduce((a, b) => ((b.cost ?? 0) > (a.cost ?? 0) ? b : a))
    : null

  // ---- tracking window -------------------------------------------------------------
  const startedAt = db.firstEventTimestamp()
  const lastActivity = db.lastActivityTimestamp()

  return {
    period,
    periodLabel: periodLabel(period),
    counts: {
      userMessages,
      assistantMessages,
      modelRequests: totals.requests,
      sessions,
      mainAgentRequests,
      subagentRequests,
      systemRequests,
    },
    tokens: {
      input: totals.inputTokens,
      output: totals.outputTokens,
      reasoning: totals.reasoningTokens,
      cacheRead: totals.cacheReadTokens,
      cacheWrite: totals.cacheWriteTokens,
      total: totals.totalTokens,
      grossInput: totals.grossInput,
    },
    cache: {
      available: cacheAvailable,
      hitRate,
      cacheReadTokens: cacheReportingEvents.read,
      cacheWriteTokens: cacheReportingEvents.write,
      estimatedSavings: cacheSavings,
    },
    cost: {
      exact: exactCost,
      breakdown,
      total: breakdownTotal,
      unknown: costUnknown,
    },
    perModel: modelRows,
    perProvider: providerRows,
    averages: {
      inputTokensPerUserMessage: userMessages > 0 ? totals.grossInput / userMessages : null,
      outputTokensPerAssistantResponse: assistantMessages > 0 ? totals.outputTokens / assistantMessages : null,
    },
    topModels: { mostUsed, mostExpensive },
    largestRequest: largest,
    tracking: { startedAt, lastActivity },
  }
}

function aggregateInto(target: AggRow, source: EventRow): void {
  target.requests += 1
  target.totalTokens += source.total_tokens
  target.inputTokens += source.input_tokens
  target.outputTokens += source.output_tokens
  target.reasoningTokens += source.reasoning_tokens
  target.cacheReadTokens += source.cache_read_tokens
  target.cacheWriteTokens += source.cache_write_tokens
  target.grossInput += source.input_tokens + source.cache_read_tokens + source.cache_write_tokens
  if (source.cost !== null) target.cost = (target.cost ?? 0) + source.cost
}
