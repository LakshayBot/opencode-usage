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
import { computeReport } from "../../reporting/usage-report.ts"
import { UsageDatabase } from "../../storage/database.ts"
import type { ReportFilter, ReportPeriod, UsageReport } from "../../types/usage.ts"
import { formatNumber } from "./usage-format.ts"
import { UsageEmptyView, UsageErrorView } from "./usage-view.tsx"
import {
  buildUsageModels,
  buildUsageOverview,
  buildUsagePeriodSummaries,
  buildUsageProviders,
  type UsageModelRowModel,
} from "./usage-view-model.ts"
import { UsageOverviewView, type OverviewAction } from "./usage-overview.tsx"
import {
  UsageHistoryDialog,
  UsageModelDetailView,
  UsageModelsDialog,
  UsageProvidersDialog,
} from "./usage-views.tsx"

type ReportResult = { kind: "ok"; report: UsageReport } | { kind: "error"; error: string }

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
 * Compute a report for the route/period. NEVER throws: every failure returns
 * an error payload that renders as a visible in-popup message.
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
    return { kind: "ok", report: computeReport(db, period, filter, { pricing }) }
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
