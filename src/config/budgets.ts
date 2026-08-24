/**
 * Spend-budget configuration for the /usage TUI overview.
 *
 * Budgets live in `$XDG_CONFIG_HOME/opencode-usage/budgets.json` (USD):
 *
 *   { "daily": 2, "monthly": 30, "warnAt": 0.8 }
 *
 * Every field is optional. An absent (or unreadable/malformed) file disables
 * budgets entirely — the feature never creates state of its own. Invalid
 * entries (negative, non-finite or non-numeric amounts) are ignored one by
 * one; when nothing valid remains, budgets stay disabled. `warnAt` is the
 * fraction of the budget where a line flips from ok to warn; it must lie in
 * (0, 1] to count, otherwise the 0.8 default applies.
 *
 * Loading is synchronous (`readFileSync` + try/catch — the popup renders
 * synchronously and must never throw) with no top-level await anywhere.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Env } from "../opencode/paths.ts"

/** Config directory under the XDG config root that holds our config files. */
export const BUDGETS_CONFIG_DIRNAME = "opencode-usage"

/** Location of the budgets file relative to the XDG config root (docs/tests). */
export const BUDGETS_CONFIG_PATH = `${BUDGETS_CONFIG_DIRNAME}/budgets.json`

/** Fraction of the budget at which a line turns into a warning. */
export const DEFAULT_WARN_AT = 0.8

export interface Budgets {
  daily: number | null
  monthly: number | null
  warnAt: number
}

/**
 * Directory containing budgets.json for the running user:
 * `$XDG_CONFIG_HOME/opencode-usage` (falling back to `~/.config`). Env is an
 * argument for testability, mirroring resolvePaths.
 */
export function budgetsConfigDir(env: Env = process.env): string {
  const home = env.OPENCODE_TEST_HOME ?? env.HOME ?? os.homedir()
  const xdgConfigHome = env.XDG_CONFIG_HOME || path.join(home, ".config")
  return path.join(xdgConfigHome, BUDGETS_CONFIG_DIRNAME)
}

/** Absolute path of the budgets file inside `configDir`. */
export function budgetsFilePath(configDir: string): string {
  return path.join(configDir, path.basename(BUDGETS_CONFIG_PATH))
}

/**
 * Normalize a parsed budgets.json payload. Returns null when no usable budget
 * remains; never throws.
 */
export function validateBudgets(raw: unknown): Budgets | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const daily = validAmount(record.daily)
  const monthly = validAmount(record.monthly)
  if (daily === null && monthly === null) return null
  return { daily, monthly, warnAt: validWarnAt(record.warnAt) ?? DEFAULT_WARN_AT }
}

/** Finite non-negative numbers only; anything else disables the entry. */
function validAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
  return value
}

/** warnAt must be a fraction in (0, 1]; anything else falls back to the default. */
function validWarnAt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) return null
  return value
}

/**
 * Read + validate the budgets file in `configDir`. Missing files, malformed
 * JSON and empty validations all mean the same thing: budgets disabled (null).
 */
export function loadBudgets(configDir: string): Budgets | null {
  let contents: string
  try {
    contents = fs.readFileSync(budgetsFilePath(configDir), "utf8")
  } catch {
    return null
  }
  try {
    return validateBudgets(JSON.parse(contents))
  } catch {
    return null
  }
}
