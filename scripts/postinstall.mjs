#!/usr/bin/env node
/**
 * Auto-install the opencode-usage integration after a GLOBAL npm install.
 *
 * `npm i -g @skinnysheep/opencode-usage` should be the entire setup
 * experience: this postinstall runs exactly the same idempotent `install`
 * routine as `opencode-usage install`, so after a normal global install (or
 * upgrade) you only need to restart opencode.
 *
 * Safety:
 *  - Runs ONLY for global installs (`npm_config_global === "true"`). When the
 *    package lands as a regular dependency (another project, CI build, ...)
 *    it does nothing and never touches that machine's config.
 *  - Opt out with OPENCODE_USAGE_AUTO_INSTALL=0 (or npm --ignore-scripts).
 *  - Best-effort: any failure prints the manual fallback command and the npm
 *    install still completes successfully.
 */
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const globalInstall = process.env.npm_config_global === "true"
const disabled = process.env.OPENCODE_USAGE_AUTO_INSTALL === "0"

if (!globalInstall) process.exit(0)
if (disabled) {
  console.log("[opencode-usage] auto-install skipped (OPENCODE_USAGE_AUTO_INSTALL=0). Run \`opencode-usage install\` when ready.")
  process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = (rel) => pathToFileURL(path.join(here, "..", "dist", rel)).href

try {
  const { resolvePaths } = await import(dist("opencode/paths.js"))
  const { install } = await import(dist("opencode/installer.js"))
  const { VERSION } = await import(dist("version.js"))

  const paths = resolvePaths()
  const result = install(paths, VERSION)

  console.log("")
  console.log("[opencode-usage] global integration installed:")
  console.log(`  Server plugin : ${paths.serverPluginPath} (${result.serverPlugin})`)
  console.log(`  TUI plugin    : ${paths.tuiPluginPath} (${result.tuiPlugin})`)
  console.log(`  tui.json      : ${paths.tuiConfigPath} (${result.tuiConfig})`)
  if (result.tuiConfigError) console.log(`  NOTE          : ${result.tuiConfigError}`)
  console.log(`  Database      : ${paths.usageDbPath}`)
  console.log("")
  console.log("Restart opencode (or start a new session), then select /usage in the palette.")
  console.log("Manage the integration manually with \`opencode-usage install\` / \`opencode-usage uninstall\` (disable auto-install with OPENCODE_USAGE_AUTO_INSTALL=0).")
} catch (error) {
  console.warn("[opencode-usage] auto-install failed:", String(error))
  console.warn("Run \`opencode-usage install\` manually to set up the integration.")
}
process.exit(0)
