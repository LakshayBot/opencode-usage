/**
 * Platform-aware path resolution.
 *
 * Mirrors opencode's own path scheme exactly (opencode uses the `xdg-basedir`
 * package; verified in packages/core/src/global.ts):
 *
 *   config dir  : $OPENCODE_CONFIG_DIR ?? (win32: %APPDATA%/opencode   : $XDG_CONFIG_HOME|~/.config + /opencode)
 *   data dir    : (win32: %LOCALAPPDATA%/opencode  : $XDG_DATA_HOME|~/.local/share + /opencode)
 *
 * Our usage database lives in a sibling data dir named `opencode-usage`.
 *
 * All functions accept an env object for testability.
 */

import os from "node:os"
import path from "node:path"

export interface Paths {
  /** opencode global config directory (where plugins/commands live). */
  configDir: string
  /** opencode global data directory (contains opencode.db). */
  opencodeDataDir: string
  /** Our global data directory. */
  usageDataDir: string
  /** Our SQLite database file. */
  usageDbPath: string
  /** Installed server plugin file. */
  serverPluginPath: string
  /** Installed TUI plugin file. */
  tuiPluginPath: string
  /** Global tui config file (tui.json). */
  tuiConfigPath: string
  /** Global commands dir. */
  commandsDir: string
  /** Installed usage command file. */
  commandPath: string
}

export type Env = Record<string, string | undefined>

function homeDir(env: Env): string {
  return env.OPENCODE_TEST_HOME ?? env.HOME ?? os.homedir()
}

function xdgConfigHome(env: Env): string {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME
  if (process.platform === "win32") return env.APPDATA ?? path.join(homeDir(env), "AppData", "Roaming")
  return path.join(homeDir(env), ".config")
}

function xdgDataHome(env: Env): string {
  if (env.XDG_DATA_HOME) return env.XDG_DATA_HOME
  if (process.platform === "win32") return env.LOCALAPPDATA ?? path.join(homeDir(env), "AppData", "Local")
  return path.join(homeDir(env), ".local", "share")
}

export function resolvePaths(env: Env = process.env): Paths {
  const configDir = env.OPENCODE_CONFIG_DIR
    ? path.resolve(env.OPENCODE_CONFIG_DIR)
    : path.join(xdgConfigHome(env), "opencode")
  const opencodeDataDir = path.join(xdgDataHome(env), "opencode")
  const usageDataDir = path.join(xdgDataHome(env), "opencode-usage")

  return {
    configDir,
    opencodeDataDir,
    usageDataDir,
    usageDbPath: path.join(usageDataDir, "usage.db"),
    serverPluginPath: path.join(configDir, "plugin", "opencode-usage.js"),
    tuiPluginPath: path.join(configDir, "opencode-usage.tui.js"),
    tuiConfigPath: path.join(configDir, "tui.json"),
    commandsDir: path.join(configDir, "commands"),
    commandPath: path.join(configDir, "commands", "usage.md"),
  }
}
