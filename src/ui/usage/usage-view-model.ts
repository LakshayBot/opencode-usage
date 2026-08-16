/**
 * Presentation view models for the /usage TUI.
 *
 * The TUI never touches raw database rows or `UsageReport` internals directly;
 * it renders these pre-normalized structures. Keeping the data layer
 * (`reporting/usage-report.ts`) and the presentation layer separate means the
 * popup can change freely without affecting tracking, tokens, cache or costs.
 */

import type { ModelRow, ProviderRow, ReportPeriod, UsageReport } from "../../types/usage.ts"

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
