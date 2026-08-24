/**
 * `opencode-usage export` — dump a period's usage as JSON or CSV.
 *
 * All numbers come from the shared reporting layer: daily buckets from
 * computeUsageTimeline (same selection/axis rules as the TUI graph, but
 * UNBOUNDED — the graph's 30-bucket display cap never truncates an export)
 * and per-model rows from computeReport (same as `stats`). This module only
 * formats — no SQL lives here.
 */

import fs from "node:fs"

import { expandHome, parsePeriod } from "./index.ts"
import { resolvePaths } from "../opencode/paths.ts"
import { HybridPricingProvider } from "../pricing/modelsdev.ts"
import { UsageDatabase } from "../storage/database.ts"
import {
  computeReport,
  computeUsageTimeline,
  periodLabel,
  type ReportOptions,
  type TimelineBucket,
} from "../reporting/usage-report.ts"
import type { UsageReport } from "../types/usage.ts"
import type { ReportPeriod } from "../types/usage.ts"

export interface RunExportOptions {
  /** Positional args after the subcommand: [period]. */
  args?: string[]
  /** Parsed flags: --json, --csv, --out <file>. */
  flags?: Record<string, string | boolean>
  /** Overrides resolvePaths().usageDbPath (tests). */
  dbPath?: string
  /** Clock override for period windows (tests). */
  now?: number
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

/**
 * Escape one CSV cell: values containing a comma, quote or newline get
 * double-quote wrapped with embedded quotes doubled. Session titles and
 * bucket labels are user-influenced, so every cell goes through this.
 */
export function csvEscape(value: string | number | null): string {
  if (value === null) return ""
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

const DAILY_HEADER = "label,start,end,input_tokens,output_tokens,total_tokens,cost"
const MODELS_HEADER = "provider,model,requests,input_tokens,output_tokens,total_tokens,cost"

function csvRow(fields: Array<string | number | null>): string {
  return fields.map(csvEscape).join(",")
}

function renderCsv(daily: TimelineBucket[], models: UsageReport["perModel"]): string {
  const lines: string[] = ["# daily buckets", DAILY_HEADER]
  for (const b of daily) {
    lines.push(csvRow([b.label, b.start, b.end, b.inputTokens, b.outputTokens, b.totalTokens, b.cost]))
  }
  lines.push("")
  lines.push("# models", MODELS_HEADER)
  for (const m of models) {
    lines.push(csvRow([m.provider, m.model, m.requests, m.inputTokens, m.outputTokens, m.totalTokens, m.cost]))
  }
  return lines.join("\n") + "\n"
}

export function runExport(options: RunExportOptions = {}): void {
  const flags = options.flags ?? {}
  const args = options.args ?? []
  const format: "json" | "csv" = flags.csv ? "csv" : "json"

  let outPath: string | undefined
  if (flags.out !== undefined) {
    if (typeof flags.out !== "string" || flags.out.length === 0) fail("--out requires a file path")
    outPath = expandHome(flags.out)
  }

  const dbPath = options.dbPath ?? resolvePaths().usageDbPath
  if (!fs.existsSync(dbPath)) fail(`no usage database at ${dbPath} — run \`opencode-usage install\` first`)

  // Export defaults to 'all' (stats defaults to 'session').
  const period: ReportPeriod = args[0] === undefined ? { kind: "all" } : parsePeriod(args[0])

  const db = UsageDatabase.open(dbPath, { readOnly: true })
  let daily: TimelineBucket[]
  let models: UsageReport["perModel"]
  try {
    const pricing = new HybridPricingProvider(db)
    const reportOptions: ReportOptions = { pricing, now: options.now, maxBuckets: null }
    daily = computeUsageTimeline(db, period, {}, reportOptions)
    models = computeReport(db, period, {}, reportOptions).perModel
  } finally {
    db.close()
  }

  const content =
    format === "json"
      ? JSON.stringify({ period: periodLabel(period), generatedAt: new Date().toISOString(), daily, models }, null, 2) + "\n"
      : renderCsv(daily, models)

  if (outPath) {
    fs.writeFileSync(outPath, content)
    process.stderr.write(`wrote ${outPath}\n`)
  } else {
    process.stdout.write(content)
  }
}
