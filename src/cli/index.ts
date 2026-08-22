#!/usr/bin/env node
/**
 * opencode-usage CLI.
 *
 *   opencode-usage install         Install the global integration
 *   opencode-usage uninstall       Remove the integration (keeps history)
 *   opencode-usage uninstall --purge   ...and delete the database
 *   opencode-usage status          Show installation + tracking status
 *   opencode-usage stats [period]  Print usage report (session|today|week|month|all)
 *   opencode-usage export [--csv|--json] [period] [--out <file>]
 *                                  Dump daily buckets + per-model rows
 *   opencode-usage import          Import history from opencode.db
 *   opencode-usage update-pricing  Sync pricing from models.dev
 *   opencode-usage reset           Wipe usage history (interactive confirm)
 *   opencode-usage reset --yes     Wipe usage history (automation)
 */

import fs from "node:fs"
import { detectOpenCode } from "../opencode/detector.ts"
import {
  install,
  status,
  uninstall,
  type InstallResult,
} from "../opencode/installer.ts"
import { resolvePaths } from "../opencode/paths.ts"
import { computeReport, periodLabel } from "../reporting/usage-report.ts"
import { renderReportMarkdown } from "../reporting/formatters/markdown.ts"
import { HybridPricingProvider, syncPricingFromModelsDev } from "../pricing/modelsdev.ts"
import { UsageDatabase, openDatabase, wipeDatabase } from "../storage/database.ts"
import { HistoricalImporter } from "../opencode/historical-importer.ts"
import { checkForUpdate } from "../update/checker.ts"
import { runExport } from "./export.ts"
import type { ReportFilter, ReportPeriod } from "../types/usage.ts"

import { VERSION } from "../version.ts"

function log(message: string): void {
  process.stdout.write(message + "\n")
}

// Tolerate closed pipes (e.g. `opencode-usage status | head`).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0)
  throw err
})

function error(message: string): never {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

export function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p
  if (p.startsWith("~/")) return (process.env.HOME ?? "") + p.slice(1)
  return p
}

export function parsePeriod(raw: string | undefined, sessionId?: string): ReportPeriod {
  switch (raw ?? "session") {
    case "session":
      return { kind: "session", sessionId: sessionId ?? "current" }
    case "today":
      return { kind: "today" }
    case "week":
      return { kind: "week" }
    case "month":
      return { kind: "month" }
    case "all":
      return { kind: "all" }
    default:
      error(`unknown period "${raw}" (expected: session|today|week|month|all)`)
  }
}

export function parseFilter(args: string[]): { filter: ReportFilter; rest: string[] } {
  const filter: ReportFilter = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    if ((arg === "model" || arg === "provider") && next !== undefined) {
      if (arg === "model") filter.model = next
      else filter.provider = next
      i++
    } else if (arg !== undefined) {
      rest.push(arg)
    }
  }
  return { filter, rest }
}

async function confirm(prompt: string): Promise<boolean> {
  process.stderr.write(`${prompt} [y/N] `)
  for await (const line of process.stdin) {
    const answer = line.trim().toLowerCase()
    return answer === "y" || answer === "yes"
  }
  return false
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function cmdInstall(flags: Record<string, string | boolean>): Promise<void> {
  const paths = resolvePaths()
  const detection = detectOpenCode()
  if (!detection.found && !flags["no-detect"]) {
    log("warning: opencode binary not detected — installing anyway (it will load on next opencode start)")
  } else if (detection.found && detection.version) {
    log(`OpenCode detected: ${detection.version}`)
  }

  const result: InstallResult = install(paths, VERSION)
  log("")
  log("opencode-usage installed:")
  log(`  Server plugin : ${paths.serverPluginPath} (${result.serverPlugin})`)
  log(`  TUI plugin    : ${paths.tuiPluginPath} (${result.tuiPlugin})`)
  log(`  tui.json      : ${paths.tuiConfigPath} (${result.tuiConfig})`)
  if (result.tuiConfigError) log(`  NOTE          : ${result.tuiConfigError}`)
  log(`  Legacy command: ${result.command === "removed" ? "removed old usage.md (installed by a previous version)" : "none — /usage is the native TUI popup"}`)
  log(`  Database      : ${paths.usageDbPath}`)
  log("")
  log("Restart opencode (or start a new session) for the integration to load.")
  log("Select /usage in the palette for the native report popup (zero tokens, any model).")
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

async function cmdUninstall(flags: Record<string, string | boolean>): Promise<void> {
  const paths = resolvePaths()
  const purge = Boolean(flags.purge)
  if (purge) {
    const yes = flags.yes === true || (await confirm("Delete the usage database too? This cannot be undone."))
    if (!yes) {
      log("aborted. Use --yes to skip the confirmation.")
      return
    }
  }
  const result = uninstall(paths, { purge })
  log("opencode-usage uninstalled:")
  log(`  Server plugin : ${result.serverPlugin}`)
  log(`  TUI plugin    : ${result.tuiPlugin}`)
  log(`  tui.json      : ${result.tuiConfig}`)
  log(`  Command       : ${result.command}`)
  log(`  Database      : ${result.database} (${paths.usageDbPath})`)
  log("")
  log("Usage history was preserved." + (purge ? " (purged)" : " Run `opencode-usage uninstall --purge` to delete it."))
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus(): void {
  const paths = resolvePaths()
  const detection = detectOpenCode()
  const s = status(paths, { detected: detection.found, binaryPath: detection.binaryPath, version: detection.version }, VERSION)

  log("OpenCode detected:    " + (s.opencode.detected ? "Yes" : "No") + (s.opencode.version ? ` (${s.opencode.version})` : ""))
  log(`Server plugin:        ${s.serverPlugin ? "Yes" : "No"}  ${paths.serverPluginPath}`)
  log(`TUI plugin:           ${s.tuiPlugin ? "Yes" : "No"}  ${paths.tuiPluginPath}`)
  log(`tui.json entry:       ${s.tuiConfig ? "Yes" : "No"}`)
  log(`Legacy command file:  ${s.command ? "Yes (run install to remove)" : "No"}`)
  log(`Tracking database:    ${s.databaseExists ? "Yes" : "No"}  ${s.dbPath}`)
  log(`Tracked model calls:  ${s.trackedMessages === null ? "n/a" : s.trackedMessages.toLocaleString("en-US")}`)
  log(`Tracking since:       ${s.trackingSince ?? "n/a"}`)
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function cmdStats(args: string[], flags: Record<string, string | boolean>): void {
  const paths = resolvePaths()
  if (!fs.existsSync(paths.usageDbPath)) {
    error(`no usage database at ${paths.usageDbPath} — run \`opencode-usage install\` first`)
  }
  const { filter, rest } = parseFilter(args)
  const period = parsePeriod(rest[0])
  const db = UsageDatabase.open(paths.usageDbPath, { readOnly: true })
  const pricing = new HybridPricingProvider(db)
  const report = computeReport(db, period, filter, { pricing })
  db.close()
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
    return
  }
  log(renderReportMarkdown(report))
  log("")
  log(`Note: period "${periodLabel(period)}". Pass a period: session|today|week|month|all`)
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

function cmdExport(args: string[], flags: Record<string, string | boolean>): void {
  runExport({ args, flags })
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

async function cmdImport(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const paths = resolvePaths()
  const opencodeDb = flags["opencode-db"] ? expandHome(String(flags["opencode-db"])) : paths.opencodeDataDir + "/opencode.db"

  let since: number | undefined
  if (flags.since) {
    const parsed = Date.parse(String(flags.since))
    if (Number.isNaN(parsed)) error(`invalid --since date: ${flags.since}`)
    since = parsed
  }

  let importer: HistoricalImporter
  try {
    importer = new HistoricalImporter(opencodeDb)
  } catch (err) {
    error(String(err))
  }
  const target = UsageDatabase.open(paths.usageDbPath)
  log(`Importing from ${opencodeDb} ...`)
  let lastProgress = ""
  const result = importer.importAll(target, {
    since,
    onProgress: (done, total) => {
      const text = `  usage events: ${done.toLocaleString("en-US")}`
      if (text !== lastProgress) {
        lastProgress = text
        process.stderr.write(`\r${text}   `)
      }
    },
  })
  process.stderr.write("\r\x1b[K")
  importer.close()
  target.close()

  log(`Found sessions:         ${result.sessionsFound.toLocaleString("en-US")}`)
  log(`Usage events discovered: ${result.eventsDiscovered.toLocaleString("en-US")}`)
  log(`Already imported:       ${result.alreadyImported.toLocaleString("en-US")}`)
  log(`New events imported:    ${result.newImported.toLocaleString("en-US")}`)
  log(`Messages imported:      ${result.messagesImported.toLocaleString("en-US")}`)
  if (result.skippedDueToError > 0) log(`Skipped (bad rows):     ${result.skippedDueToError}`)
}

// ---------------------------------------------------------------------------
// update-pricing
// ---------------------------------------------------------------------------

async function cmdUpdatePricing(): Promise<void> {
  const paths = resolvePaths()
  const db = UsageDatabase.open(paths.usageDbPath)
  try {
    log("Fetching pricing from models.dev ...")
    const result = await syncPricingFromModelsDev(db)
    log(`Providers: ${result.providers}`)
    log(`Pricing rows found:     ${result.models.toLocaleString("en-US")}`)
    log(`New rows imported:      ${result.imported.toLocaleString("en-US")}`)
    log(`Skipped (already have): ${result.skipped.toLocaleString("en-US")}`)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

async function cmdReset(flags: Record<string, string | boolean>): Promise<void> {
  const paths = resolvePaths()
  if (!fs.existsSync(paths.usageDbPath)) {
    log("No usage database found — nothing to reset.")
    return
  }
  const yes = flags.yes === true || (await confirm(`Wipe ALL usage history in ${paths.usageDbPath}?`))
  if (!yes) {
    log("aborted. Use --yes to skip the confirmation.")
    return
  }
  wipeDatabase(paths.usageDbPath)
  log("Usage history reset. Live tracking continues on the next opencode session.")
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=")
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next
          i++
        } else {
          flags[arg.slice(2)] = true
        }
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

const HELP = `opencode-usage v${VERSION}

Track OpenCode token usage, cache statistics and estimated costs.

Usage:
  opencode-usage install            Install the global /usage integration
  opencode-usage uninstall          Remove the integration (keeps history)
  opencode-usage uninstall --purge  Remove the integration and the database
  opencode-usage status             Show installation + tracking status
  opencode-usage stats [period]     Print a usage report
  opencode-usage stats --json       Machine-readable report
  opencode-usage export [--csv|--json] [period] [--out <file>]
                                    Dump daily buckets + per-model rows
  opencode-usage import             Import history from opencode's database
  opencode-usage update-pricing     Sync model pricing from models.dev
  opencode-usage reset [--yes]      Wipe usage history

Periods: session | today | week | month | all   (stats default: session, export default: all)
Filters: stats [period] model <id> | provider <id>

Options:
  --json              JSON output for stats
  --csv               CSV output for export
  --out <file>        Write export to a file instead of stdout
  --since <date>      Import only events after this date (ISO)
  --opencode-db <path> Override the opencode database path for import
  -y, --yes           Skip confirmations (automation)
`

export async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2))
  const command = positional[0]

  switch (command) {
    case "install":
      await cmdInstall(flags)
      break
    case "uninstall":
      await cmdUninstall(flags)
      break
    case "status":
      cmdStatus()
      break
    case "stats":
      cmdStats(positional.slice(1), flags)
      break
    case "export":
      cmdExport(positional.slice(1), flags)
      break
    case "import":
      await cmdImport(positional.slice(1), flags)
      break
    case "update-pricing":
      await cmdUpdatePricing()
      break
    case "reset":
      await cmdReset(flags)
      break
    case "help":
    case "--help":
    case "-h":
    case undefined:
      log(HELP)
      break
    case "version":
    case "--version":
    case "-v":
      log(VERSION)
      break
    default:
      error(`unknown command "${command}" — run \`opencode-usage help\``)
  }

  if (!isInfoCommand(command)) {
    const notice = await checkForUpdate()
    if (notice) process.stderr.write(`\n${notice}\n\n`)
  }
}

function isInfoCommand(command: string | undefined): boolean {
  return (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    command === "version" ||
    command === "--version" ||
    command === "-v"
  )
}
