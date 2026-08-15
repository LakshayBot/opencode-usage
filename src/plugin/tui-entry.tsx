/**
 * opencode-usage TUI plugin (referenced from ~/.config/opencode/tui.json).
 *
 * Registers /usage (plus /usage today|week|month|all) in the TUI command
 * palette; selecting one navigates to a native OpenTUI route rendering the
 * report — zero LLM tokens consumed.
 *
 * Rendering contract: the route render function must return a complete JSX
 * tree synchronously — no signals/onMount (the host renders the returned
 * tree without guaranteed reactive updates). Everything is computed before
 * returning, and every failure path renders a visible error instead of
 * hanging on a loading state.
 *
 * Bundled self-contained. JSX runtime imports (solid-js, @opentui/solid) are
 * kept external: the opencode TUI host rewrites them to its own runtime
 * modules (opentui runtime-plugin-support).
 */

import { For } from "solid-js"
import { box, scrollbox, text } from "@opentui/solid"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

import { resolvePaths } from "../opencode/paths.ts"
import { HybridPricingProvider } from "../pricing/modelsdev.ts"
import { computeReport } from "../reporting/usage-report.ts"
import { UsageDatabase } from "../storage/database.ts"
import type { ReportFilter, ReportPeriod, UsageReport } from "../types/usage.ts"

export default {
  id: "opencode-usage",
  tui: async (api: TuiPluginApi) => {
    // ---- back-navigation state ---------------------------------------------
    // The plugin route has no built-in way back (the app only renders our
    // route content and the session view's keybindings are unmounted). We
    // remember where the user came from and install esc/q bindings that are
    // active only while the usage route is open.
    let backUnregister: (() => void) | null = null
    let backTarget: { name: "home" } | { name: "session"; sessionID: string } | null = null

    function goBack(): void {
      backUnregister?.()
      backUnregister = null
      const target = backTarget
      backTarget = null
      if (target?.name === "session") {
        api.route.navigate("session", { sessionID: target.sessionID })
      } else {
        api.route.navigate("home")
      }
    }

    function navigate(period: ReportPeriod): void {
      const params: Record<string, unknown> = { kind: period.kind }
      if (period.kind === "session") params.sessionId = period.sessionId

      // Remember where we came from (unless we are already on the usage route).
      const current = api.route.current
      if (current?.name !== "usage") {
        if (current?.name === "session" && typeof current.params?.sessionID === "string") {
          backTarget = { name: "session", sessionID: current.params.sessionID }
        } else {
          backTarget = { name: "home" }
        }
      }

      // Install esc/q bindings once per visit.
      if (!backUnregister) {
        backUnregister = api.keymap.registerLayer({
          commands: [{ name: "opencode-usage.back", run: () => goBack() }],
          bindings: [
            { key: "escape", cmd: "opencode-usage.back" },
            { key: "q", cmd: "opencode-usage.back" },
          ],
        })
      }

      api.route.navigate("usage", params)
    }

    /** Navigate using the currently open session when one exists (else today). */
    function navigateCurrentSession(): void {
      const current = api.route.current
      const sessionId =
        current?.name === "session" && typeof current.params?.sessionID === "string"
          ? current.params.sessionID
          : undefined
      if (sessionId) {
        navigate({ kind: "session", sessionId })
      } else {
        navigate({ kind: "today" })
      }
    }

    api.route.register([
      {
        name: "usage",
        render: ({ params }) => {
          // Everything happens synchronously here — never return a loading
          // placeholder that depends on reactive updates.
          return <UsageReportView api={api} params={params} />
        },
      },
    ])

    api.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: "usage",
          title: "OpenCode usage",
          desc: "Usage for the current session",
          category: "Usage",
          slashName: "usage",
          run: () => navigateCurrentSession(),
        },
        {
          namespace: "palette",
          name: "usage.today",
          title: "OpenCode usage — today",
          desc: "Usage since midnight",
          category: "Usage",
          slashName: "usage today",
          run: () => navigate({ kind: "today" }),
        },
        {
          namespace: "palette",
          name: "usage.week",
          title: "OpenCode usage — last 7 days",
          desc: "Usage over the last 7 days",
          category: "Usage",
          slashName: "usage week",
          run: () => navigate({ kind: "week" }),
        },
        {
          namespace: "palette",
          name: "usage.month",
          title: "OpenCode usage — last 30 days",
          desc: "Usage over the last 30 days",
          category: "Usage",
          slashName: "usage month",
          run: () => navigate({ kind: "month" }),
        },
        {
          namespace: "palette",
          name: "usage.all",
          title: "OpenCode usage — all time",
          desc: "Usage since tracking began",
          category: "Usage",
          slashName: "usage all",
          run: () => navigate({ kind: "all" }),
        },
      ],
      bindings: [],
    })
  },
}

/** Synchronous view: computes the report before returning JSX. */
function UsageReportView(props: { api: TuiPluginApi; params?: Record<string, unknown> }) {
  const report = computeReportSafely(resolvePeriod(props.params))
  return (
    <box width="100%" height="100%" paddingX={2} paddingY={1} backgroundColor={props.api.theme?.current?.backgroundPanel}>
      <scrollbox height="100%" width="100%" scrollbarOptions={{ visible: false }}>
        <ReportBody report={report} theme={props.api.theme?.current} />
      </scrollbox>
    </box>
  )
}

function ReportBody(props: { report: UsageReport | { error: string }; theme: TuiThemeCurrent | undefined }) {
  const t = props.theme
  if ("error" in props.report) {
    return (
      <box>
        <text fg={t?.text}>OpenCode Usage</text>
        <text fg={t?.textMuted}>{"\n"}</text>
        <text fg={t?.error}>Tracking database unavailable: {props.report.error}</text>
      </box>
    )
  }
  const report = props.report

  const rows: Array<{ text: string; bold?: boolean; dim?: boolean }> = []
  rows.push({ text: `OpenCode Usage — ${report.periodLabel}`, bold: true })
  rows.push({ text: "" })
  rows.push({ text: "MESSAGES", bold: true })
  rows.push({ text: `  User Messages:         ${fmt(report.counts.userMessages)}` })
  rows.push({ text: `  Assistant Messages:    ${fmt(report.counts.assistantMessages)}` })
  rows.push({ text: `  Model Requests:        ${fmt(report.counts.modelRequests)}` })
  rows.push({ text: `  Sessions:              ${fmt(report.counts.sessions)}` })
  if (report.counts.subagentRequests > 0) {
    rows.push({ text: `  Main Agent Requests:   ${fmt(report.counts.mainAgentRequests)}` })
    rows.push({ text: `  Subagent Requests:     ${fmt(report.counts.subagentRequests)}` })
  }
  if (report.counts.systemRequests > 0) rows.push({ text: `  System/Internal:       ${fmt(report.counts.systemRequests)}` })
  rows.push({ text: "" })
  rows.push({ text: "TOKENS", bold: true })
  rows.push({ text: `  Input:                 ${fmt(report.tokens.input)}` })
  rows.push({ text: `  Output:                ${fmt(report.tokens.output)}` })
  if (report.tokens.reasoning > 0) rows.push({ text: `  Reasoning:             ${fmt(report.tokens.reasoning)}` })
  rows.push({ text: `  Cache Read:            ${fmt(report.tokens.cacheRead)}` })
  rows.push({ text: `  Cache Write:           ${fmt(report.tokens.cacheWrite)}` })
  rows.push({ text: `  Total Processed:       ${fmt(report.tokens.total)}` })
  rows.push({ text: "" })
  rows.push({ text: "CACHE", bold: true })
  if (!report.cache.available) {
    rows.push({ text: "  Cache data: Not available" })
  } else {
    rows.push({ text: `  Cache Hit Rate:        ${pct(report.cache.hitRate)}` })
    rows.push({ text: `  Cache Read Tokens:     ${fmtT(report.cache.cacheReadTokens)}` })
    rows.push({ text: `  Cache Write Tokens:    ${fmtT(report.cache.cacheWriteTokens)}` })
    rows.push({
      text: `  Estimated Savings:     ${report.cache.estimatedSavings === null ? "Unknown" : cost(report.cache.estimatedSavings)}`,
    })
  }
  rows.push({ text: "" })
  rows.push({ text: "COST (ESTIMATED)", bold: true })
  const b = report.cost.breakdown
  rows.push({ text: `  Input Cost:            ${cost(b.input)}` })
  rows.push({ text: `  Output Cost:           ${cost(b.output)}` })
  rows.push({ text: `  Cache Read Cost:       ${cost(b.cacheRead)}` })
  rows.push({ text: `  Cache Write Cost:      ${cost(b.cacheWrite)}` })
  rows.push({ text: `  Estimated Total:       ${report.cost.unknown ? "Unknown" : cost(report.cost.total)}` })
  if (report.cost.exact !== null) {
    rows.push({ text: `  (opencode-computed:    ${cost(report.cost.exact)})`, dim: true })
  }
  rows.push({ text: "" })
  rows.push({ text: "TOP MODELS", bold: true })
  if (report.perModel.length === 0) {
    rows.push({ text: "  No model activity in this period." })
  } else {
    report.perModel.slice(0, 5).forEach((row, index) => {
      rows.push({
        text: `  ${index + 1}. ${row.model} (${row.provider})  ${fmtT(row.totalTokens)} tokens / ${fmt(row.requests)} req / ${cost(row.cost)}`,
      })
    })
    if (report.topModels.mostExpensive) {
      rows.push({ text: `  Most expensive: ${report.topModels.mostExpensive.model} — ${cost(report.topModels.mostExpensive.cost)}` })
    }
  }
  rows.push({ text: "" })
  if (report.perProvider.length > 0) {
    rows.push({ text: "PER PROVIDER", bold: true })
    for (const row of report.perProvider) {
      rows.push({ text: `  ${row.provider}: ${fmt(row.requests)} req / ${fmtT(row.totalTokens)} tokens / ${cost(row.cost)}` })
    }
    rows.push({ text: "" })
  }
  rows.push({ text: "DETAILS", bold: true })
  rows.push({ text: `  Avg input per user msg:  ${fmt(report.averages.inputTokensPerUserMessage ?? 0)} tokens` })
  rows.push({ text: `  Avg output per assistant: ${fmt(report.averages.outputTokensPerAssistantResponse ?? 0)} tokens` })
  if (report.largestRequest) {
    rows.push({
      text: `  Largest request:         ${fmtT(report.largestRequest.totalTokens)} tokens (${report.largestRequest.model ?? "unknown"})`,
    })
  }
  if (report.tracking.startedAt) rows.push({ text: `  Tracking since:          ${date(report.tracking.startedAt)}` })
  if (report.tracking.lastActivity) rows.push({ text: `  Last activity:           ${date(report.tracking.lastActivity)}` })
  rows.push({ text: "" })
  rows.push({ text: "All costs are ESTIMATED. Actual billing may differ.", dim: true })
  rows.push({ text: "esc / q — back to your session", dim: true })

  return (
    <box>
      <For each={rows}>
        {(row) => (
          <text fg={row.dim ? t?.textMuted : t?.text} bold={row.bold}>
            {row.text}
          </text>
        )}
      </For>
    </box>
  )
}

/**
 * Compute a report for the route. NEVER throws: every failure path returns an
 * error payload that renders as a visible message (the render contract forbids
 * hanging on a loading placeholder).
 */
function computeReportSafely(period: ReportPeriod): UsageReport | { error: string } {
  let db: UsageDatabase | null = null
  try {
    const paths = resolvePaths()
    db = UsageDatabase.open(paths.usageDbPath, { readOnly: true })
    const pricing = new HybridPricingProvider(db)
    return computeReport(db, period, {}, { pricing })
  } catch (error) {
    return { error: String(error) }
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

function resolvePeriod(params: Record<string, unknown> | undefined): ReportPeriod {
  switch (params?.kind) {
    case "today":
      return { kind: "today" }
    case "week":
      return { kind: "week" }
    case "month":
      return { kind: "month" }
    case "all":
      return { kind: "all" }
    default:
      return { kind: "session", sessionId: typeof params?.sessionId === "string" ? params.sessionId : "current" }
  }
}

function fmt(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value))
}
function fmtT(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}
function cost(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unknown"
  if (value === 0) return "$0.00"
  if (Math.abs(value) >= 100) return `$${value.toFixed(0)}`
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}
function pct(value: number | null): string {
  if (value === null) return "n/a"
  return `${(value * 100).toFixed(1)}%`
}
function date(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16)
}
