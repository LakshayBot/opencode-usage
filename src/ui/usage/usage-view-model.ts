/**
 * Presentation view models for the /usage TUI.
 *
 * The TUI never touches raw database rows or `UsageReport` internals directly;
 * it renders these pre-normalized structures. Keeping the data layer
 * (`reporting/usage-report.ts`) and the presentation layer separate means the
 * popup can change freely without affecting tracking, tokens, cache or costs.
 */

import type { Budgets } from "../../config/budgets.ts"
import type { PeriodComparison, TimelineBucket } from "../../reporting/usage-report.ts"
import type { AgentRow, ModelRow, ProjectRow, ProviderRow, ReportPeriod, SessionRow, UsageReport } from "../../types/usage.ts"
import { formatCost, formatTokens } from "./usage-format.ts"

/** The primary summary shown on the first /usage screen. */
export interface UsageOverviewModel {
  periodLabel: string
  /** user + assistant messages */
  messages: number
  requests: number
  sessions: number
  totalTokens: number
  /** best available cost signal: breakdown total, else opencode-computed. */
  cost: number | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheHitRate: number | null
  cacheAvailable: boolean
  modelCount: number
  providerCount: number
  trackingSince: number | null
  hasData: boolean
}

export function buildUsageOverview(report: UsageReport): UsageOverviewModel {
  const breakdownTotal = report.cost.unknown ? null : report.cost.total
  const cost = breakdownTotal ?? report.cost.exact ?? null
  return {
    periodLabel: report.periodLabel,
    messages: report.counts.userMessages + report.counts.assistantMessages,
    requests: report.counts.modelRequests,
    sessions: report.counts.sessions,
    totalTokens: report.tokens.total,
    cost,
    inputTokens: report.tokens.input,
    outputTokens: report.tokens.output,
    reasoningTokens: report.tokens.reasoning,
    cacheReadTokens: report.tokens.cacheRead,
    cacheWriteTokens: report.tokens.cacheWrite,
    cacheHitRate: report.cache.hitRate,
    cacheAvailable: report.cache.available,
    modelCount: report.perModel.length,
    providerCount: report.perProvider.length,
    trackingSince: report.tracking.startedAt,
    hasData: report.counts.modelRequests > 0 || report.counts.userMessages > 0,
  }
}

export interface UsageModelRowModel {
  model: string
  provider: string
  requests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cost: number | null
}

export function buildUsageModels(report: UsageReport): UsageModelRowModel[] {
  return report.perModel.map((row: ModelRow) => ({
    model: row.model,
    provider: row.provider,
    requests: row.requests,
    totalTokens: row.totalTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: row.cost,
  }))
}

export interface UsageProviderRowModel {
  provider: string
  requests: number
  totalTokens: number
  cost: number | null
}

export function buildUsageProviders(report: UsageReport): UsageProviderRowModel[] {
  return report.perProvider.map((row: ProviderRow) => ({
    provider: row.provider,
    requests: row.requests,
    totalTokens: row.totalTokens,
    cost: row.cost,
  }))
}

export interface UsageAgentRowModel {
  agent: string
  requests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cost: number | null
}

export function buildUsageAgents(report: UsageReport): UsageAgentRowModel[] {
  return report.perAgent.map((row: AgentRow) => ({
    agent: row.agent,
    requests: row.requests,
    totalTokens: row.totalTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: row.cost,
  }))
}

export interface UsageProjectRowModel {
  project: string
  requests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cost: number | null
}

export function buildUsageProjects(report: UsageReport): UsageProjectRowModel[] {
  return report.perProject.map((row: ProjectRow) => ({
    project: row.project,
    requests: row.requests,
    totalTokens: row.totalTokens,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: row.cost,
  }))
}

export interface UsageSessionRowModel {
  sessionId: string
  /** Session title truncated to MAX_TITLE_CHARS (ellipsis included). */
  displayTitle: string
  requests: number
  totalTokens: number
  cost: number | null
  lastActivity: number
}

/** Long session titles must not push the token/cost columns out of the popup. */
export const MAX_SESSION_TITLE_CHARS = 40

function truncateTitle(title: string): string {
  if (title.length <= MAX_SESSION_TITLE_CHARS) return title
  return title.slice(0, MAX_SESSION_TITLE_CHARS - 1) + "…"
}

export function buildUsageSessions(report: UsageReport): UsageSessionRowModel[] {
  return report.perSession.map((row: SessionRow) => ({
    sessionId: row.sessionId,
    displayTitle: truncateTitle(row.title),
    requests: row.requests,
    totalTokens: row.totalTokens,
    cost: row.cost,
    lastActivity: row.lastActivity,
  }))
}

export interface UsagePeriodSummary {
  period: ReportPeriod
  label: string
  requests: number
  totalTokens: number
  cost: number | null
}

export function buildPeriodSummary(report: UsageReport): UsagePeriodSummary {
  const overview = buildUsageOverview(report)
  return {
    period: report.period,
    label: report.periodLabel,
    requests: overview.requests,
    totalTokens: overview.totalTokens,
    cost: overview.cost,
  }
}

/** Build summaries for a set of periods (used by the History view). */
export function buildUsagePeriodSummaries(reports: UsageReport[]): UsagePeriodSummary[] {
  return reports.map(buildPeriodSummary)
}

// ---- Graph view (tokens/cost over time) --------------------------------------

/** Target bar width in characters — wide enough to read shape, narrow enough
 *  to fit the popup next to labels and token/cost columns. */
export const TIMELINE_BAR_WIDTH = 24

const BAR_CHARACTER = "█"

/** What the graph bars scale to: token volume (default) or dollar cost. */
export type UsageTimelineMetric = "tokens" | "cost"

export interface UsageTimelineOptions {
  /** Bars scale by this bucket field; defaults to "tokens". */
  metric?: UsageTimelineMetric
}

export interface UsageTimelineRowModel {
  label: string
  /** Unicode block chars scaled to the busiest bucket; "" for zero buckets. */
  bar: string
  totalTokens: number
  cost: number | null
  tokensText: string
  costText: string
}

export interface UsageTimelinePresentation {
  rows: UsageTimelineRowModel[]
  /** false -> every bucket lacks pricing; the view hides the cost column. */
  costKnown: boolean
  /** hourly buckets were folded into daily ones to keep the popup compact */
  foldedToDaily: boolean
}

/**
 * Render-ready rows for the "Graph" view, shaped for the popup:
 *
 *  1. Empty leading/trailing buckets are trimmed so the axis hugs the data —
 *     a session that touched two hours must not render a full 24-hour axis of
 *     "0 / —" rows (interior zero buckets stay: gaps in activity are real).
 *  2. Hourly ranges longer than `TIMELINE_FOLD_TO_DAILY_AFTER` buckets are
 *     folded into daily buckets, mirroring the reporting layer's daily label
 *     format, so a multi-day session stays scannable.
 *  3. The busiest bucket spans the full `TIMELINE_BAR_WIDTH`; every bucket
 *     with a positive value keeps at least one bar character.
 *
 * In "cost" mode bars scale by bucket cost instead of tokens, and buckets with
 * unknown pricing cannot be placed on that scale at all: they are excluded from
 * the max computation and render an empty bar with "?" as their cost text
 * (never "$0.00"). In "tokens" mode unknown costs render as "—" — the view
 * hides the cost column entirely when `costKnown` is false.
 */
export function buildUsageTimelineModel(buckets: TimelineBucket[], options: UsageTimelineOptions = {}): UsageTimelinePresentation {
  let scoped = trimEmptyEdges(buckets)
  let foldedToDaily = false
  if (scoped.length > TIMELINE_FOLD_TO_DAILY_AFTER) {
    const folded = foldToDaily(scoped)
    if (folded.length < scoped.length) {
      scoped = folded
      foldedToDaily = true
    }
  }

  const rows =
    (options.metric ?? "tokens") === "tokens"
      ? timelineTokenRows(scoped)
      : timelineCostRows(scoped)
  return { rows, costKnown: rows.some((row) => row.cost !== null), foldedToDaily }
}

/** Hourly axes longer than this become daily before rendering. */
export const TIMELINE_FOLD_TO_DAILY_AFTER = 24

function trimEmptyEdges(buckets: TimelineBucket[]): TimelineBucket[] {
  let start = 0
  let end = buckets.length
  while (start < end && buckets[start]!.totalTokens === 0) start++
  while (end > start && buckets[end - 1]!.totalTokens === 0) end--
  return buckets.slice(start, end)
}

const TIMELINE_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

function timelineDayLabel(ms: number): string {
  const d = new Date(ms)
  return `${TIMELINE_WEEKDAYS[d.getDay()] ?? "?"} ${d.getDate()}`
}

function timelineDayFloor(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Merge consecutive hourly buckets into one per local day (sum tokens, and
 *  cost turns unknown if any merged bucket was unknown). */
function foldToDaily(buckets: TimelineBucket[]): TimelineBucket[] {
  const out: TimelineBucket[] = []
  let current: TimelineBucket | null = null
  for (const bucket of buckets) {
    if (current === null || timelineDayFloor(current.start) !== timelineDayFloor(bucket.start)) {
      if (current !== null) out.push(current)
      current = { ...bucket, label: timelineDayLabel(bucket.start) }
    } else {
      current.inputTokens += bucket.inputTokens
      current.outputTokens += bucket.outputTokens
      current.totalTokens += bucket.totalTokens
      current.end = bucket.end
      if (bucket.cost === null) current.cost = null
      else if (current.cost !== null) current.cost += bucket.cost
    }
  }
  if (current !== null) out.push(current)
  return out
}

function timelineTokenRows(buckets: TimelineBucket[]): UsageTimelineRowModel[] {
  const maxTotal = buckets.reduce((max, bucket) => Math.max(max, bucket.totalTokens), 0)
  return buckets.map((bucket) => ({
    label: bucket.label,
    bar: timelineBar(bucket.totalTokens, maxTotal),
    totalTokens: bucket.totalTokens,
    cost: bucket.cost,
    tokensText: formatTokens(bucket.totalTokens),
    costText: bucket.cost === null ? "—" : formatCost(bucket.cost),
  }))
}

function timelineCostRows(buckets: TimelineBucket[]): UsageTimelineRowModel[] {
  // Cost mode — unknown-pricing buckets stay invisible to the scale.
  const maxCost = buckets.reduce((max, bucket) => (bucket.cost !== null && bucket.cost > max ? bucket.cost : max), 0)
  return buckets.map((bucket) => ({
    label: bucket.label,
    bar: bucket.cost === null ? "" : timelineBar(bucket.cost, maxCost),
    totalTokens: bucket.totalTokens,
    cost: bucket.cost,
    tokensText: formatTokens(bucket.totalTokens),
    costText: bucket.cost === null ? "?" : formatCost(bucket.cost),
  }))
}

function timelineBar(value: number, maxValue: number): string {
  if (value <= 0 || maxValue <= 0) return ""
  const width = Math.max(1, Math.round((value / maxValue) * TIMELINE_BAR_WIDTH))
  return BAR_CHARACTER.repeat(Math.min(TIMELINE_BAR_WIDTH, width))
}

// ---- period comparison ("vs prev" line on the overview) ----------------------

export interface UsageComparisonModel {
  /** False -> the overview hides the block entirely ('session'/'all'). */
  available: boolean
  /** Complete compact line, ready to render muted under the tabs. */
  text: string
  requestsText: string
  totalTokensText: string
  costText: string
}

/** '+34%' (up), '-12%' (down), 'new' (nothing before) or '—' (not comparable). */
function comparisonMetricText(pct: number | null, previous: number | null, current: number | null): string {
  if (pct !== null) return `${pct < 0 ? "-" : "+"}${Math.abs(pct)}%`
  if (previous === 0 && (current ?? 0) > 0) return "new"
  return "—"
}

export function buildComparisonModel(cmp: PeriodComparison): UsageComparisonModel {
  const requestsText = comparisonMetricText(cmp.delta.requestsPct, cmp.previous.requests, cmp.current.requests)
  const totalTokensText = comparisonMetricText(cmp.delta.totalTokensPct, cmp.previous.totalTokens, cmp.current.totalTokens)
  const costText = comparisonMetricText(cmp.delta.costPct, cmp.previous.cost, cmp.current.cost)
  return {
    available: cmp.available,
    text: cmp.available ? `vs prev ${cmp.label}: req ${requestsText} · tok ${totalTokensText} · cost ${costText}` : "",
    requestsText,
    totalTokensText,
    costText,
  }
}

// ---- budgets (spend vs configured limits) ------------------------------------

export type BudgetLineLevel = "ok" | "warn" | "over"

export interface BudgetLineModel {
  label: "Daily" | "Monthly"
  /** Ready-to-render line, e.g. '$2.10 of $5.00 (42%)'. Unknown spend renders
   *  as 'unknown of $5.00' — the leading 'unknown' is the renderer's cue for
   *  distinct muted styling. */
  text: string
  level: BudgetLineLevel
}

export interface UsageBudgetModel {
  /** False -> the overview hides the block entirely (no budgets configured). */
  visible: boolean
  lines: BudgetLineModel[]
}

/** Integer percent thresholds; Math.round absorbs float noise in warnAt*100. */
function budgetLine(label: "Daily" | "Monthly", budget: number, spend: number | null, warnAt: number): BudgetLineModel {
  if (spend === null) {
    return { label, text: `unknown of ${formatCost(budget)}`, level: "ok" }
  }
  // budget 0 with positive spend can't be expressed as a percent — it is over.
  const ratio = budget > 0 ? spend / budget : spend > 0 ? Number.POSITIVE_INFINITY : 0
  const pct = Number.isFinite(ratio) ? Math.round(ratio * 100) : null
  const level: BudgetLineLevel = pct === null || pct >= 100 ? "over" : pct >= Math.round(warnAt * 100) ? "warn" : "ok"
  return { label, text: `${formatCost(spend)} of ${formatCost(budget)} (${pct ?? ">100"}%)`, level }
}

/**
 * Render-ready budget lines for the overview, one per configured window
 * ('Daily' first). Hidden entirely when no budgets are configured; a null
 * spend (unknown-cost event in the window) keeps the line visible but muted.
 */
export function buildBudgetModel(budgets: Budgets | null, spendDaily: number | null, spendMonthly: number | null): UsageBudgetModel {
  if (!budgets || (budgets.daily === null && budgets.monthly === null)) {
    return { visible: false, lines: [] }
  }
  const lines: BudgetLineModel[] = []
  if (budgets.daily !== null) lines.push(budgetLine("Daily", budgets.daily, spendDaily, budgets.warnAt))
  if (budgets.monthly !== null) lines.push(budgetLine("Monthly", budgets.monthly, spendMonthly, budgets.warnAt))
  return { visible: true, lines }
}
