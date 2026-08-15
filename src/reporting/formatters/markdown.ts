/**
 * Markdown renderer for UsageReport. Used by the `usage` tool (rendered by
 * the model in the terminal) and the CLI `stats` command.
 */

import type { UsageReport } from "../../types/usage.ts"

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value))
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

export function formatCost(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unknown"
  if (value === 0) return "$0.00"
  if (Math.abs(value) >= 100) return `$${value.toFixed(0)}`
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16)
}

export function formatPercent(value: number | null): string {
  if (value === null) return "n/a"
  return `${(value * 100).toFixed(1)}%`
}

/** Render a full report as markdown (the `/usage` output in the chat). */
export function renderReportMarkdown(report: UsageReport): string {
  const lines: string[] = []
  const hr = "──".repeat(20)

  lines.push("", hr, "             OPENCODE USAGE", hr, "", `Period: ${report.periodLabel}`)

  // Messages
  lines.push("", "MESSAGES", `User Messages:          ${formatNumber(report.counts.userMessages)}`)
  lines.push(`Assistant Messages:     ${formatNumber(report.counts.assistantMessages)}`)
  lines.push(`Model Requests:         ${formatNumber(report.counts.modelRequests)}`)
  lines.push(`Sessions:               ${formatNumber(report.counts.sessions)}`)
  if (report.counts.subagentRequests > 0) {
    lines.push(`Main Agent Requests:    ${formatNumber(report.counts.mainAgentRequests)}`)
    lines.push(`Subagent Requests:      ${formatNumber(report.counts.subagentRequests)}`)
  }
  if (report.counts.systemRequests > 0) {
    lines.push(`System/Internal:        ${formatNumber(report.counts.systemRequests)}`)
  }

  // Tokens
  lines.push("", "TOKENS", `Input:                  ${formatNumber(report.tokens.input)}`)
  lines.push(`Output:                 ${formatNumber(report.tokens.output)}`)
  if (report.tokens.reasoning > 0) lines.push(`Reasoning:              ${formatNumber(report.tokens.reasoning)}`)
  lines.push(`Cache Read:             ${formatNumber(report.tokens.cacheRead)}`)
  lines.push(`Cache Write:            ${formatNumber(report.tokens.cacheWrite)}`)
  lines.push("─".repeat(30), `Total Processed:        ${formatNumber(report.tokens.total)}`)

  // Cache
  lines.push("", "CACHE")
  if (!report.cache.available) {
    lines.push("Cache data: Not available")
  } else {
    lines.push(`Cache Hit Rate:         ${formatPercent(report.cache.hitRate)}`)
    lines.push(`Cache Read Tokens:      ${formatTokens(report.cache.cacheReadTokens)}`)
    lines.push(`Cache Write Tokens:     ${formatTokens(report.cache.cacheWriteTokens)}`)
    lines.push(
      `Estimated Cache Savings: ${report.cache.estimatedSavings === null ? "Unknown" : formatCost(report.cache.estimatedSavings)}`,
    )
  }

  // Cost
  lines.push("", "COST (ESTIMATED)")
  const b = report.cost.breakdown
  lines.push(`Input Cost:             ${formatCost(b.input)}`)
  lines.push(`Output Cost:            ${formatCost(b.output)}`)
  lines.push(`Cache Read Cost:        ${formatCost(b.cacheRead)}`)
  lines.push(`Cache Write Cost:       ${formatCost(b.cacheWrite)}`)
  lines.push("─".repeat(30))
  if (report.cost.unknown) {
    lines.push("Estimated Total:        Unknown (pricing unavailable for some models)")
  } else {
    lines.push(`Estimated Total:        ${formatCost(report.cost.total)}`)
  }
  if (report.cost.exact !== null) {
    lines.push(`(opencode-computed at use: ${formatCost(report.cost.exact)})`)
  }

  // Top models
  lines.push("", "TOP MODELS")
  if (report.perModel.length === 0) {
    lines.push("No model activity in this period.")
  } else {
    const top = report.perModel.slice(0, 5)
    top.forEach((row, index) => {
      lines.push(
        `${index + 1}. ${row.model} (${row.provider})  ${formatTokens(row.totalTokens)} tokens / ${formatNumber(row.requests)} req / ${formatCost(row.cost)}`,
      )
    })
    if (report.topModels.mostExpensive) {
      lines.push(
        `Most expensive: ${report.topModels.mostExpensive.model} — ${formatCost(report.topModels.mostExpensive.cost)}`,
      )
    }
  }

  if (report.perProvider.length > 0) {
    lines.push("", "PER PROVIDER")
    for (const row of report.perProvider) {
      lines.push(
        `${row.provider}: ${formatNumber(row.requests)} req / ${formatTokens(row.totalTokens)} tokens / ${formatCost(row.cost)}`,
      )
    }
  }

  // Averages + largest
  lines.push("", "DETAILS")
  lines.push(`Avg input per user message:   ${formatNumber(report.averages.inputTokensPerUserMessage ?? 0)} tokens`)
  lines.push(`Avg output per assistant msg: ${formatNumber(report.averages.outputTokensPerAssistantResponse ?? 0)} tokens`)
  if (report.largestRequest) {
    lines.push(
      `Largest single request:        ${formatTokens(report.largestRequest.totalTokens)} tokens (${report.largestRequest.model ?? "unknown"}, ${formatDate(report.largestRequest.timestamp)})`,
    )
  }

  lines.push("", hr)

  if (report.tracking.startedAt) {
    lines.push(`Tracking since: ${formatDate(report.tracking.startedAt)}`)
  }
  if (report.tracking.lastActivity) {
    lines.push(`Last activity:  ${formatDate(report.tracking.lastActivity)}`)
  }
  lines.push("", "All costs are ESTIMATED. Actual billing may differ.", "")
  return lines.join("\n")
}
