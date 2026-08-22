/**
 * Presentation view models for the /usage TUI.
 *
 * The TUI never touches raw database rows or `UsageReport` internals directly;
 * it renders these pre-normalized structures. Keeping the data layer
 * (`reporting/usage-report.ts`) and the presentation layer separate means the
 * popup can change freely without affecting tracking, tokens, cache or costs.
 */

import type { TimelineBucket } from "../../reporting/usage-report.ts"
import type { ModelRow, ProviderRow, ReportPeriod, UsageReport } from "../../types/usage.ts"
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

/**
 * Render-ready rows for the "Graph" view. The busiest bucket spans the full
 * `TIMELINE_BAR_WIDTH`; every bucket with a positive value keeps at least one
 * bar character so activity stays visible, zero buckets render an empty bar.
 *
 * In "cost" mode bars scale by bucket cost instead of tokens, and buckets with
 * unknown pricing cannot be placed on that scale at all: they are excluded from
 * the max computation and render an empty bar with "?" as their cost text
 * (never "$0.00"). `tokensText` shows the token count in either mode.
 */
export function buildUsageTimelineModel(buckets: TimelineBucket[], options: UsageTimelineOptions = {}): UsageTimelineRowModel[] {
  if ((options.metric ?? "tokens") === "tokens") {
    const maxTotal = buckets.reduce((max, bucket) => Math.max(max, bucket.totalTokens), 0)
    return buckets.map((bucket) => ({
      label: bucket.label,
      bar: timelineBar(bucket.totalTokens, maxTotal),
      totalTokens: bucket.totalTokens,
      cost: bucket.cost,
      tokensText: formatTokens(bucket.totalTokens),
      costText: formatCost(bucket.cost),
    }))
  }
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
