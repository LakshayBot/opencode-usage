/**
 * /usage popup orchestration.
 *
 * Opening and switching views goes through the host's native dialog stack
 * (`api.ui.dialog`). The dialog supplies the dimmed backdrop, centered
 * `backgroundPanel` surface, fixed widths and Esc/ctrl+c close handling — the
 * popup therefore behaves like OpenCode's own theme/model selectors.
 *
 * Every render path is synchronous and never throws: failures and empty
 * databases render as native in-popup states instead of crashing opencode.
 */

import type { JSX } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { resolvePaths } from "../../opencode/paths.ts"
import { HybridPricingProvider } from "../../pricing/modelsdev.ts"
import { buildComparison, computeReport, computeUsageTimeline, periodLabel, type PeriodComparison, type TimelineBucket } from "../../reporting/usage-report.ts"
import { UsageDatabase } from "../../storage/database.ts"
import type { ReportFilter, ReportPeriod, UsageReport } from "../../types/usage.ts"
import { formatNumber } from "./usage-format.ts"
import { UsageEmptyView, UsageErrorView } from "./usage-view.tsx"
import {
  buildComparisonModel,
  buildUsageAgents,
  buildUsageModels,
  buildUsageOverview,
  buildUsagePeriodSummaries,
  buildUsageProjects,
  buildUsageProviders,
  buildUsageSessions,
  type UsageModelRowModel,
  type UsageTimelineMetric,
} from "./usage-view-model.ts"
import { UsageAgentsDialog } from "./usage-agents.tsx"
import { UsageGraphView } from "./usage-graph.tsx"
import { UsageOverviewView, type OverviewAction } from "./usage-overview.tsx"
import { UsageProjectsDialog } from "./usage-projects.tsx"
import { UsageSessionsDialog } from "./usage-sessions.tsx"
import {
  UsageHistoryDialog,
  UsageModelDetailView,
  UsageModelsDialog,
  UsageProvidersDialog,
} from "./usage-views.tsx"

type ReportResult = { kind: "ok"; report: UsageReport; comparison: PeriodComparison } | { kind: "error"; error: string }

/** Open /usage for the given period. */
export function openUsage(api: TuiPluginApi, period: ReportPeriod): void {
  showOverview(api, period)
}

export function showOverview(api: TuiPluginApi, period: ReportPeriod, selectedIndex = 0): void {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => renderOverview(api, period, selectedIndex), undefined)
}

export function showModels(api: TuiPluginApi, period: ReportPeriod): void {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => renderModels(api, period), undefined)
}

export function showProviders(api: TuiPluginApi, period: ReportPeriod): void {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => renderProviders(api, period), undefined)
}

export function showAgents(api: TuiPluginApi, period: ReportPeriod): void {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => renderAgents(api, period), undefined)
}

export function showProjects(api: TuiPluginApi, period: ReportPeriod): void {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => renderProjects(api, period), undefined)
}

export function showSessions(api: TuiPluginApi, period: ReportPeriod): void {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => renderSessions(api, period), undefined)
}

export function showGraph(api: TuiPluginApi, period: ReportPeriod, metric: UsageTimelineMetric = "tokens"): void {
  api.ui.dialog.setSize("large")
  // Metric state lives HERE, not inside the component: the host renderer does
  // not reliably redraw plugin-rendered dialog content on reactive updates
  // (same empirically-verified limitation as overview row highlights), so a
  // signal flip alone repaints nothing. Re-calling dialog.replace forces the
  // host to mount fresh content — the same workaround showOverview uses for
  // navigation. The binding's run() re-invokes this with the flipped metric.
  api.ui.dialog.replace(() => renderGraph(api, period, metric), undefined)
}

export function showHistory(api: TuiPluginApi, period: ReportPeriod): void {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => renderHistory(api, period), undefined)
}

export function showModelDetail(api: TuiPluginApi, period: ReportPeriod, model: UsageModelRowModel): void {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(
    () => <UsageModelDetailView api={api} model={model} onBack={() => showModels(api, period)} />,
    undefined,
  )
}

/**
 * The period tabs shown inside the popup. Built once per open from the route
 * (a "Session" tab appears when /usage is opened from inside a session) so the
 * tab order stays stable while the user switches periods.
 */
function buildPeriodTabs(api: TuiPluginApi): ReportPeriod[] {
  const tabs: ReportPeriod[] = [{ kind: "today" }, { kind: "week" }, { kind: "month" }, { kind: "all" }]
  const current = api.route.current
  if (current?.name === "session" && typeof current.params?.sessionID === "string") {
    tabs.unshift({ kind: "session", sessionId: current.params.sessionID })
  }
  return tabs
}

function renderOverview(api: TuiPluginApi, period: ReportPeriod, selectedIndex = 0): JSX.Element {
  const result = computeReportSafely(period)
  if (result.kind === "error") return <UsageErrorView api={api} error={result.error} />
  const overview = buildUsageOverview(result.report)
  if (!overview.hasData) return <UsageEmptyView api={api} periodLabel={overview.periodLabel} />
  const actions = buildActions(api, period, result.report)
  return (
    <UsageOverviewView
      api={api}
      overview={overview}
      comparison={buildComparisonModel(result.comparison)}
      actions={actions}
      tabs={buildPeriodTabs(api)}
      activePeriod={period}
      onSelectPeriod={(next) => showOverview(api, next)}
      selectedIndex={selectedIndex}
      onNavigate={(next) => showOverview(api, period, next)}
    />
  )
}

function buildActions(api: TuiPluginApi, period: ReportPeriod, report: UsageReport): OverviewAction[] {
  const actions: OverviewAction[] = []
  if (report.perModel.length > 0) {
    actions.push({
      title: "By model",
      description: `${formatNumber(report.perModel.length)} model${report.perModel.length === 1 ? "" : "s"}`,
      run: () => showModels(api, period),
    })
  }
  if (report.perProvider.length > 0) {
    actions.push({
      title: "By provider",
      description: `${formatNumber(report.perProvider.length)} provider${report.perProvider.length === 1 ? "" : "s"}`,
      run: () => showProviders(api, period),
    })
  }
  if (report.perAgent.length > 0) {
    actions.push({
      title: "By agent",
      description: `${formatNumber(report.perAgent.length)} agent${report.perAgent.length === 1 ? "" : "s"}`,
      run: () => showAgents(api, period),
    })
  }
  if (report.perProject.length > 0) {
    actions.push({
      title: "By project",
      description: `${formatNumber(report.perProject.length)} project${report.perProject.length === 1 ? "" : "s"}`,
      run: () => showProjects(api, period),
    })
  }
  if (report.perSession.length > 0) {
    actions.push({
      title: "By session",
      description: `${formatNumber(report.perSession.length)} session${report.perSession.length === 1 ? "" : "s"}`,
      run: () => showSessions(api, period),
    })
  }
  actions.push({
    title: "Graph",
    description: "Tokens over time",
    run: () => showGraph(api, period),
  })
  actions.push({
    title: "History",
    description: "Change the time period",
    run: () => showHistory(api, period),
  })
  return actions
}

function renderModels(api: TuiPluginApi, period: ReportPeriod): JSX.Element {
  const result = computeReportSafely(period)
  if (result.kind === "error") return <UsageErrorView api={api} error={result.error} />
  const rows = buildUsageModels(result.report)
  if (rows.length === 0) return <UsageEmptyView api={api} periodLabel={result.report.periodLabel} />
  return <UsageModelsDialog api={api} rows={rows} onSelectModel={(row) => showModelDetail(api, period, row)} />
}

function renderProviders(api: TuiPluginApi, period: ReportPeriod): JSX.Element {
  const result = computeReportSafely(period)
  if (result.kind === "error") return <UsageErrorView api={api} error={result.error} />
  const rows = buildUsageProviders(result.report)
  if (rows.length === 0) return <UsageEmptyView api={api} periodLabel={result.report.periodLabel} />
  return <UsageProvidersDialog api={api} rows={rows} />
}

function renderAgents(api: TuiPluginApi, period: ReportPeriod): JSX.Element {
  const result = computeReportSafely(period)
  if (result.kind === "error") return <UsageErrorView api={api} error={result.error} />
  const rows = buildUsageAgents(result.report)
  if (rows.length === 0) return <UsageEmptyView api={api} periodLabel={result.report.periodLabel} />
  return <UsageAgentsDialog api={api} rows={rows} onBack={() => showOverview(api, period)} />
}

function renderProjects(api: TuiPluginApi, period: ReportPeriod): JSX.Element {
  const result = computeReportSafely(period)
  if (result.kind === "error") return <UsageErrorView api={api} error={result.error} />
  const rows = buildUsageProjects(result.report)
  if (rows.length === 0) return <UsageEmptyView api={api} periodLabel={result.report.periodLabel} />
  return <UsageProjectsDialog api={api} rows={rows} onBack={() => showOverview(api, period)} />
}

function renderSessions(api: TuiPluginApi, period: ReportPeriod): JSX.Element {
  const result = computeReportSafely(period)
  if (result.kind === "error") return <UsageErrorView api={api} error={result.error} />
  const rows = buildUsageSessions(result.report)
  if (rows.length === 0) return <UsageEmptyView api={api} periodLabel={result.report.periodLabel} />
  return <UsageSessionsDialog api={api} rows={rows} onBack={() => showOverview(api, period)} />
}

function renderGraph(api: TuiPluginApi, period: ReportPeriod, metric: UsageTimelineMetric): JSX.Element {
  const result = computeTimelineSafely(period)
  if (result.kind === "error") return <UsageErrorView api={api} error={result.error} />
  if (result.buckets.length === 0) return <UsageEmptyView api={api} periodLabel={periodLabel(period)} />
  return (
    <UsageGraphView
      api={api}
      periodLabel={periodLabel(period)}
      buckets={result.buckets}
      metric={metric}
      onBack={() => showOverview(api, period)}
      onToggleMetric={(next) => showGraph(api, period, next)}
    />
  )
}

function renderHistory(api: TuiPluginApi, period: ReportPeriod): JSX.Element {
  const result = computeHistorySummaries(period)
  if (result.kind === "error") return <UsageErrorView api={api} error={result.error} />
  return (
    <UsageHistoryDialog
      api={api}
      summaries={result.summaries}
      activePeriod={period}
      onSelectPeriod={(next) => showOverview(api, next)}
    />
  )
}

function buildPeriodCandidates(current: ReportPeriod): ReportPeriod[] {
  const candidates: ReportPeriod[] = [{ kind: "today" }, { kind: "week" }, { kind: "month" }, { kind: "all" }]
  if (current.kind === "session") candidates.unshift(current)
  return candidates
}

function computeHistorySummaries(
  period: ReportPeriod,
): { kind: "ok"; summaries: ReturnType<typeof buildUsagePeriodSummaries> } | { kind: "error"; error: string } {
  let db: UsageDatabase | null = null
  try {
    const paths = resolvePaths()
    const database = UsageDatabase.open(paths.usageDbPath, { readOnly: true })
    db = database
    const pricing = new HybridPricingProvider(database)
    const reports = buildPeriodCandidates(period).map((candidate) => computeReport(database, candidate, {}, { pricing }))
    return { kind: "ok", summaries: buildUsagePeriodSummaries(reports) }
  } catch (error) {
    return { kind: "error", error: String(error) }
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        // closing must never mask the report
      }
    }
  }
}

/**
 * Compute the tokens-over-time buckets for the route/period. NEVER throws:
 * every failure returns an error payload that renders as a visible in-popup
 * message (same contract as computeReportSafely).
 */
export function computeTimelineSafely(
  period: ReportPeriod,
  filter: ReportFilter = {},
): { kind: "ok"; buckets: TimelineBucket[] } | { kind: "error"; error: string } {
  let db: UsageDatabase | null = null
  try {
    const paths = resolvePaths()
    db = UsageDatabase.open(paths.usageDbPath, { readOnly: true })
    const pricing = new HybridPricingProvider(db)
    return { kind: "ok", buckets: computeUsageTimeline(db, period, filter, { pricing }) }
  } catch (error) {
    return { kind: "error", error: String(error) }
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        // closing must never mask the report
      }
    }
  }
}

/**
 * Compute a report (+ period comparison) for the route/period. NEVER throws:
 * every failure returns an error payload that renders as a visible in-popup
 * message.
 */
export function computeReportSafely(
  period: ReportPeriod,
  filter: ReportFilter = {},
): ReportResult {
  let db: UsageDatabase | null = null
  try {
    const paths = resolvePaths()
    db = UsageDatabase.open(paths.usageDbPath, { readOnly: true })
    const pricing = new HybridPricingProvider(db)
    return {
      kind: "ok",
      report: computeReport(db, period, filter, { pricing }),
      comparison: buildComparison(db, period, filter, { pricing }),
    }
  } catch (error) {
    return { kind: "error", error: String(error) }
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        // closing must never mask the report
      }
    }
  }
}
