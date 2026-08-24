/**
 * Installer: installs, uninstalls, and reports status of the global
 * opencode-usage integration.
 *
 * Installed artifacts (all owned by us, all idempotent):
 *   <config>/plugin/opencode-usage.js        — server plugin (auto-discovered)
 *   <config>/opencode-usage.tui.js           — TUI plugin (referenced from tui.json)
 *   <config>/tui.json                        — plugin array entry (created/merged)
 *   <config>/commands/usage.md               — global /usage command
 *   <data>/opencode-usage/usage.db           — tracking database
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Paths } from "./paths.ts"
import { openDatabase } from "../storage/database.ts"

export const INSTALL_MARKER = "opencode-usage:installed"

export const SERVER_PLUGIN_FILE = "opencode-usage.js"
export const TUI_PLUGIN_FILE = "opencode-usage.tui.js"

export function bundledPluginPath(kind: "server" | "tui"): string {
  const here = fileURLToPath(new URL(".", import.meta.url))
  // dist/opencode/<file> -> dist/plugin/plugin-<kind>.js
  const file = kind === "server" ? "plugin-server.js" : "plugin-tui.js"
  return path.join(here, "..", "plugin", file)
}

export function pluginFileHeader(version: string): string {
  return `// ${INSTALL_MARKER} v${version} — managed by opencode-usage. Do not edit.\n`
}

export function isOwnedPluginFile(content: string): boolean {
  return content.startsWith(`// ${INSTALL_MARKER}`)
}

/** Version recorded in a deployed plugin file's marker header, or null. */
export function readDeployedPluginVersion(paths: Paths, kind: "server" | "tui"): string | null {
  try {
    const file = kind === "server" ? paths.serverPluginPath : paths.tuiPluginPath
    const content = fs.readFileSync(file, "utf8")
    if (!isOwnedPluginFile(content)) return null
    const match = new RegExp(`^// ${INSTALL_MARKER} v(\\d+\\.\\d+\\.\\d+)`, "m").exec(content)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Detect a missing or stale deployment (e.g. npm blocked the postinstall
 * script, or the package was updated without re-running `install`).
 * Returns a human-readable notice, or null when everything is in sync.
 */
export function deploymentNotice(paths: Paths, version: string): string | null {
  let configExists = false
  try {
    configExists = fs.existsSync(paths.configDir)
  } catch {
    return null
  }
  const server = readDeployedPluginVersion(paths, "server")
  const tui = readDeployedPluginVersion(paths, "tui")

  if (!configExists && server === null && tui === null) return null

  for (const [kind, deployed] of [
    ["server plugin", server],
    ["TUI plugin", tui],
  ] as const) {
    if (deployed !== null && deployed !== version) {
      return (
        `note: the installed ${kind} is v${deployed} but this package is v${version}.\n` +
        `      Run \`opencode-usage install\` and restart opencode to update it.`
      )
    }
  }

  if (server === null && tui === null) {
    return (
      `note: the /usage integration is not deployed (npm may have skipped this package's postinstall script).\n` +
      `      Run \`opencode-usage install\` and restart opencode.`
    )
  }
  if (server === null || tui === null) {
    return (
      `note: the /usage integration is only partially deployed.\n` +
      `      Run \`opencode-usage install\` and restart opencode.`
    )
  }
  return null
}

export function usageCommandMarkdown(): string {
  return [
    "---",
    'description: Show OpenCode usage statistics (tokens, cache, cost). Use /usage today|week|month|all, optionally with model <id> or provider <id>.',
    "---",
    "Generate the OpenCode usage report by calling the `usage` tool exactly once with the requested arguments and display its output to the user exactly as returned, without adding commentary.",
    "",
    "Arguments: $ARGUMENTS",
  ].join("\n") + "\n"
}

/** Signature line identifying our command template (frontmatter is strict, so no extra keys). */
const COMMAND_SIGNATURE = "Generate the OpenCode usage report by calling the `usage` tool"

export function isOwnedCommandFile(content: string): boolean {
  return content.includes(COMMAND_SIGNATURE)
}

export interface InstallResult {
  serverPlugin: "written" | "already-up-to-date"
  tuiPlugin: "written" | "already-up-to-date"
  tuiConfig: "created" | "updated" | "already-present" | "error"
  tuiConfigError?: string
  /** Legacy server command file `commands/usage.md` from pre-0.1.5 installs. */
  command: "removed" | "none"
  database: "created" | "already-initialized"
  dbPath: string
  version: string
}

export interface InstallOptions {
  /** Override bundled plugin sources (used by tests). */
  serverPluginContent?: string
  tuiPluginContent?: string
}

export function install(paths: Paths, version: string, options: InstallOptions = {}): InstallResult {
  fs.mkdirSync(paths.configDir, { recursive: true })
  fs.mkdirSync(path.join(paths.configDir, "plugin"), { recursive: true })
  fs.mkdirSync(paths.commandsDir, { recursive: true })

  const header = pluginFileHeader(version)
  const result: InstallResult = {
    serverPlugin: "already-up-to-date",
    tuiPlugin: "already-up-to-date",
    tuiConfig: "already-present",
    command: "none",
    database: "already-initialized",
    dbPath: paths.usageDbPath,
    version,
  }

  // 1. Server plugin (bundled copy + marker header).
  const serverSource = options.serverPluginContent ?? fs.readFileSync(bundledPluginPath("server"), "utf8")
  const serverContent = header + serverSource
  if (writeIfChanged(paths.serverPluginPath, serverContent)) {
    result.serverPlugin = "written"
  }

  // 2. TUI plugin (bundled copy + marker header).
  const tuiSource = options.tuiPluginContent ?? fs.readFileSync(bundledPluginPath("tui"), "utf8")
  const tuiContent = header + tuiSource
  if (writeIfChanged(paths.tuiPluginPath, tuiContent)) {
    result.tuiPlugin = "written"
  }

  // 3. tui.json plugin array entry.
  const spec = pathToFileUrlSpec(paths.tuiPluginPath)
  const tuiState = ensureTuiConfigEntry(paths.tuiConfigPath, spec)
  result.tuiConfig = tuiState.state
  result.tuiConfigError = tuiState.error

  // 4. Legacy server command file. Plain /usage is owned by the TUI plugin's
  // native popup (opencode's slash autocomplete lists keymap commands AND
  // server commands without dedup, so /usage must exist in exactly one place).
  // A previous version wrote commands/usage.md — remove it if we own it, so
  // reinstalling heals old installs and the palette shows a single /usage.
  if (fs.existsSync(paths.commandPath)) {
    const content = fs.readFileSync(paths.commandPath, "utf8")
    if (isOwnedCommandFile(content)) {
      fs.rmSync(paths.commandPath, { force: true })
      result.command = "removed"
    }
  }

  // 5. Database.
  const db = openDatabase(paths.usageDbPath)
  db.close()
  result.database = "already-initialized"

  return result
}

/**
 * Convert an absolute filesystem path into the `file://` spec opencode's TUI
 * config (`tui.json` `plugin` array) expects.
 *
 * Windows paths need special care: `C:\\Users\\...` must become
 * `file:///C:/Users/...` — the drive letter keeps its colon and the URL gains
 * a third slash. (A naive `file://` + path produces `file://C/Users/...`,
 * which parses as a remote host named `C` — opencode then cannot resolve the
 * plugin and the /usage palette entry never appears. This was the pre-0.1.5
 * Windows bug.) Paths with spaces or other special characters are
 * percent-encoded; UNC paths (\\server\\share\...) become
 * `file://server/share/...`.
 */
export function pathToFileUrlSpec(absPath: string): string {
  const normalized = absPath.replaceAll("\\", "/")
  if (normalized.startsWith("//")) {
    // UNC: \\server\\share\... → file://server/share/...
    return `file://${normalized.slice(2)}`
  }
  const url = new URL("file:///")
  url.pathname = normalized
  return url.href
}

/**
 * Canonical form of a tui.json plugin entry, used to compare entries against
 * our spec regardless of how they were written. Also repairs the legacy
 * pre-0.1.5 Windows bug (`file://C/Users/...` — drive-letter colon stripped,
 * no third slash) so re-running install heals old Windows installs in place.
 */
function normalizeEntrySpec(entry: string): string {
  const legacy = /^file:\/\/[a-zA-Z]\//.exec(entry)
  if (legacy) return `file:///${entry[7]}:${entry.slice(8)}`
  return entry
}

function writeIfChanged(file: string, content: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === content) return false
  } catch {
    // missing — proceed
  }
  fs.writeFileSync(file, content, "utf8")
  return true
}

export interface TuiConfigState {
  state: "created" | "updated" | "already-present" | "error"
  error?: string
}

export function ensureTuiConfigEntry(tuiConfigPath: string, spec: string): TuiConfigState {
  const existing = fs.existsSync(tuiConfigPath) ? fs.readFileSync(tuiConfigPath, "utf8") : null

  if (existing === null) {
    fs.writeFileSync(
      tuiConfigPath,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [spec],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    )
    return { state: "created" }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(existing)
  } catch {
    return {
      state: "error",
      error:
        `Cannot edit ${tuiConfigPath} (not valid JSON — JSONC comments are not supported). ` +
        `Add ${JSON.stringify(spec)} to its "plugin" array manually.`,
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "error", error: `${tuiConfigPath} is not a JSON object; add ${JSON.stringify(spec)} to its "plugin" array manually.` }
  }

  const config = parsed as Record<string, unknown>
  const plugins = Array.isArray(config.plugin) ? (config.plugin as unknown[]) : []
  const matchIndex = plugins.findIndex((item) => normalizeEntrySpec(String(item)) === spec)
  if (matchIndex >= 0) {
    if (plugins[matchIndex] !== spec) {
      // Legacy broken Windows spec (pre-0.1.5) for this same file — repair in place.
      plugins[matchIndex] = spec
      config.plugin = plugins
      fs.writeFileSync(tuiConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8")
      return { state: "updated" }
    }
    return { state: "already-present" }
  }
  plugins.push(spec)
  config.plugin = plugins
  fs.writeFileSync(tuiConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8")
  return { state: "updated" }
}

export function removeTuiConfigEntry(tuiConfigPath: string, spec: string): "removed" | "missing" | "error" {
  if (!fs.existsSync(tuiConfigPath)) return "missing"
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(tuiConfigPath, "utf8"))
  } catch {
    return "error"
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "error"
  const config = parsed as Record<string, unknown>
  const plugins = Array.isArray(config.plugin) ? (config.plugin as unknown[]) : []
  const next = plugins.filter((item) => normalizeEntrySpec(String(item)) !== spec)
  if (next.length === plugins.length) return "missing"
  if (next.length === 0) {
    delete config.plugin
    if (Object.keys(config).length === 1 && "$schema" in config) {
      fs.rmSync(tuiConfigPath, { force: true })
    } else {
      fs.writeFileSync(tuiConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8")
    }
  } else {
    config.plugin = next
    fs.writeFileSync(tuiConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8")
  }
  return "removed"
}

export interface UninstallOptions {
  /** Delete the usage database too (requires --purge). */
  purge: boolean
}

export interface UninstallResult {
  serverPlugin: "removed" | "missing" | "skipped-not-ours"
  tuiPlugin: "removed" | "missing" | "skipped-not-ours"
  tuiConfig: "removed" | "missing" | "error"
  command: "removed" | "missing" | "skipped-not-ours"
  database: "removed" | "kept"
  dbPath: string
}

export function uninstall(paths: Paths, options: UninstallOptions): UninstallResult {
  const spec = pathToFileUrlSpec(paths.tuiPluginPath)

  const removeOwned = (file: string): "removed" | "missing" | "skipped-not-ours" => {
    if (!fs.existsSync(file)) return "missing"
    const content = fs.readFileSync(file, "utf8")
    if (!isOwnedPluginFile(content)) return "skipped-not-ours"
    fs.rmSync(file, { force: true })
    return "removed"
  }

  const result: UninstallResult = {
    serverPlugin: removeOwned(paths.serverPluginPath),
    tuiPlugin: removeOwned(paths.tuiPluginPath),
    tuiConfig: removeTuiConfigEntry(paths.tuiConfigPath, spec),
    command: (() => {
      if (!fs.existsSync(paths.commandPath)) return "missing"
      if (!isOwnedCommandFile(fs.readFileSync(paths.commandPath, "utf8"))) return "skipped-not-ours"
      fs.rmSync(paths.commandPath, { force: true })
      return "removed"
    })(),
    database: "kept",
    dbPath: paths.usageDbPath,
  }

  if (options.purge && fs.existsSync(paths.usageDbPath)) {
    fs.rmSync(paths.usageDbPath, { force: true })
    for (const suffix of ["-wal", "-shm"]) {
      fs.rmSync(paths.usageDbPath + suffix, { force: true })
    }
    // Best effort: remove the (now possibly empty) data dir.
    try {
      fs.rmdirSync(paths.usageDataDir)
    } catch {
      // non-empty or missing — fine
    }
    result.database = "removed"
  }

  return result
}

export interface StatusResult {
  opencode: OpenCodeStatus
  serverPlugin: boolean
  tuiPlugin: boolean
  tuiConfig: boolean
  command: boolean
  databaseExists: boolean
  dbPath: string
  trackedMessages: number | null
  trackingSince: string | null
  version: string | null
}

export interface OpenCodeStatus {
  detected: boolean
  binaryPath: string | null
  version: string | null
}

export function status(paths: Paths, detection: OpenCodeStatus, version: string): StatusResult {
  const serverPlugin = fs.existsSync(paths.serverPluginPath) && isOwnedPluginFile(fs.readFileSync(paths.serverPluginPath, "utf8"))
  const tuiPlugin = fs.existsSync(paths.tuiPluginPath) && isOwnedPluginFile(fs.readFileSync(paths.tuiPluginPath, "utf8"))
  const command = fs.existsSync(paths.commandPath)
  const databaseExists = fs.existsSync(paths.usageDbPath)

  let tuiConfig = false
  if (fs.existsSync(paths.tuiConfigPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.tuiConfigPath, "utf8")) as Record<string, unknown>
      tuiConfig =
        Array.isArray(parsed.plugin) && parsed.plugin.some((item) => normalizeEntrySpec(String(item)) === pathToFileUrlSpec(paths.tuiPluginPath))
    } catch {
      tuiConfig = false
    }
  }

  let trackedMessages: number | null = null
  let trackingSince: string | null = null
  if (databaseExists) {
    try {
      const db = openDatabase(paths.usageDbPath, { readOnly: true })
      const count = db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number }
      const first = db.prepare("SELECT MIN(timestamp) AS t FROM usage_events").get() as { t: number | null }
      const since = db.prepare("SELECT value FROM tracking_metadata WHERE key = 'tracking_since'").get() as
        | { value: string }
        | undefined
      trackedMessages = count.n
      const sinceMs = since?.value ? Number(since.value) : first.t
      trackingSince = sinceMs ? new Date(sinceMs).toISOString().slice(0, 10) : null
      db.close()
    } catch {
      trackedMessages = null
    }
  }

  return {
    opencode: detection,
    serverPlugin,
    tuiPlugin,
    tuiConfig,
    command,
    databaseExists,
    dbPath: paths.usageDbPath,
    trackedMessages,
    trackingSince,
    version,
  }
}
