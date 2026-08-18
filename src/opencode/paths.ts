/**
 * Platform-aware path resolution.
 *
 * Mirrors opencode's own path scheme so the files we install (plugins,
 * tui.json, usage.db) land exactly where the running opencode reads them.
 *
 * POSIX: opencode uses xdg-basedir → $XDG_CONFIG_HOME|~/.config for config
 * and $XDG_DATA_HOME|~/.local/share for data (packages/core/src/global.ts).
 *
 * Windows: opencode's behavior is NOT consistent across builds — xdg-basedir
 * 5.x maps win32 to %APPDATA%/%LOCALAPPDATA%, but current 1.18.x installs have
 * been observed using home-dir XDG paths (~/.config/opencode,
 * ~/.local/share/opencode) with no %APPDATA% exception at all (verified on a
 * real Windows 1.18.18 machine: config + opencode.db live there, %APPDATA% is
 * never read). So on Windows we PROBE the candidate roots and prefer the one
 * that already holds live opencode files (opencode.json / opencode.db),
 * defaulting to the home-XDG root for a fresh machine.
 *
 * Overrides, in priority order:
 *   $OPENCODE_CONFIG_DIR        (config dir only)
 *   $XDG_CONFIG_HOME/$XDG_DATA_HOME
 *   installed-opencode probe    (win32 only)
 *
 * All functions accept an env object for testability.
 */

import fs from "node:fs"
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

function homeConfigRoot(env: Env): string {
  return path.join(homeDir(env), ".config")
}

function homeDataRoot(env: Env): string {
  return path.join(homeDir(env), ".local", "share")
}

function appDataConfigRoot(env: Env): string {
  return env.APPDATA ?? path.join(homeDir(env), "AppData", "Roaming")
}

function appDataDataRoot(env: Env): string {
  return env.LOCALAPPDATA ?? path.join(homeDir(env), "AppData", "Local")
}

type XdgKind = "config" | "data"

/** True when the root already holds a live opencode install's files. */
function looksLikeOpencodeRoot(root: string, kind: XdgKind): boolean {
  const file =
    kind === "config" ? path.join(root, "opencode", "opencode.json") : path.join(root, "opencode", "opencode.db")
  return fs.existsSync(file)
}

/**
 * Resolve the XDG root (config or data) opencode actually uses on this machine.
 * Env overrides win; on Windows a live-install probe chooses between the
 * home-XDG root and the %APPDATA%/%LOCALAPPDATA% root.
 */
function xdgRoot(env: Env, kind: XdgKind): string {
  const override = kind === "config" ? env.XDG_CONFIG_HOME : env.XDG_DATA_HOME
  if (override) return override

  const homeRoot = kind === "config" ? homeConfigRoot(env) : homeDataRoot(env)
  if (process.platform !== "win32") return homeRoot

  const appdataRoot = kind === "config" ? appDataConfigRoot(env) : appDataDataRoot(env)
  const homeLive = looksLikeOpencodeRoot(homeRoot, kind)
  const appdataLive = looksLikeOpencodeRoot(appdataRoot, kind)
  // Prefer the root holding opencode's real files; tie / unknown → home XDG.
  if (appdataLive && !homeLive) return appdataRoot
  return homeRoot
}

export function resolvePaths(env: Env = process.env): Paths {
  const configDir = env.OPENCODE_CONFIG_DIR
    ? path.resolve(env.OPENCODE_CONFIG_DIR)
    : path.join(xdgRoot(env, "config"), "opencode")
  const opencodeDataDir = path.join(xdgRoot(env, "data"), "opencode")
  const usageDataDir = path.join(xdgRoot(env, "data"), "opencode-usage")

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
