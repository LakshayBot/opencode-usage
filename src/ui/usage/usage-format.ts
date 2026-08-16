/**
 * Formatting helpers for the /usage TUI.
 *
 * Number/cost/date formatters are shared with the reporting layer so the CLI,
 * the `usage` tool and the TUI never drift apart. `formatTokens` is defined
 * here with the compact TUI style (`1.2K`, `48.6K`, `1.2M`) — the TUI shows
 * fewer significant digits than the report output and has less horizontal
 * room. All TUI components import from this single module.
 */

import { formatCost, formatDate, formatNumber } from "../../reporting/formatters/markdown.ts"

export { formatCost, formatDate, formatNumber }

/** Compact token counts: `1.2K`, `48.6K`, `1.2M` — never lose a digit to a
 *  trailing zero ("1.0K" renders as "1K"). */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return trimZero((value / 1_000_000).toFixed(1)) + "M"
  if (value >= 1_000) return trimZero((value / 1_000).toFixed(1)) + "K"
  return String(Math.round(value))
}

function trimZero(fraction: string): string {
  return fraction.endsWith(".0") ? fraction.slice(0, -2) : fraction
}

/** Percent with one decimal place; "N/A" when there is no meaningful value. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A"
  return `${(value * 100).toFixed(1)}%`
}
