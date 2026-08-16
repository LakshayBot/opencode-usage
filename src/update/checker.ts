/**
 * CLI update checker.
 *
 * Compares the installed version against the latest on the npm registry and
 * surfaces an "update available" notice on every `opencode-usage` command.
 *
 * Safety:
 *  - Result is cached for 24h so normal runs never touch the network.
 *  - Fetch is bounded by a 2s timeout and every failure is swallowed — the
 *    check can never block, delay or break a command.
 *  - Disable with `OPENCODE_USAGE_NO_UPDATE_CHECK=1`.
 */

import fs from "node:fs"
import path from "node:path"
import { resolvePaths, type Env, type Paths } from "../opencode/paths.ts"
import { VERSION } from "../version.ts"

const PACKAGE = "@skinnysheep/opencode-usage"
const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE}/latest`
const CACHE_TTL_MS = 24 * 3600_000
const FETCH_TIMEOUT_MS = 2000

interface UpdateCache {
  checkedAt: number
  latest: string
}

/** `1.2.3` → [1, 2, 3]; returns null for anything that is not a semver. */
export function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** True when `latest` is a greater version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av === bv) continue
    return av > bv
  }
  return false
}

export function buildUpdateNotice(latest: string): string {
  return [
    `Update available: ${VERSION} → ${latest}`,
    `  npm install -g ${PACKAGE}@latest`,
    `  opencode-usage install`,
    `  (restart opencode)`,
  ].join("\n")
}

/**
 * Check whether a newer version exists. Returns the notice text when one is
 * available, otherwise null. NEVER throws.
 */
export async function checkForUpdate(env: Env = process.env): Promise<string | null> {
  if (env.OPENCODE_USAGE_NO_UPDATE_CHECK) return null
  try {
    const paths = resolvePaths(env)
    const cached = readCache(paths)
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      return cached.latest && isNewer(cached.latest, VERSION) ? buildUpdateNotice(cached.latest) : null
    }

    const latest = await fetchLatest()
    writeCache(paths, { checkedAt: Date.now(), latest })
    return isNewer(latest, VERSION) ? buildUpdateNotice(latest) : null
  } catch {
    return null
  }
}

async function fetchLatest(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(REGISTRY_LATEST, { signal: controller.signal })
    if (!response.ok) throw new Error(`registry responded ${response.status}`)
    const data = (await response.json()) as { version?: unknown }
    if (typeof data.version !== "string") throw new Error("registry response has no version")
    return data.version
  } finally {
    clearTimeout(timer)
  }
}

function cachePath(paths: Paths): string {
  return path.join(paths.usageDataDir, "update-check.json")
}

function readCache(paths: Paths): UpdateCache | null {
  try {
    const text = fs.readFileSync(cachePath(paths), "utf8")
    const data = JSON.parse(text) as Partial<UpdateCache>
    if (typeof data.checkedAt === "number" && typeof data.latest === "string") {
      return { checkedAt: data.checkedAt, latest: data.latest }
    }
  } catch {
    // unreadable / missing cache is not an error
  }
  return null
}

function writeCache(paths: Paths, cache: UpdateCache): void {
  try {
    fs.mkdirSync(paths.usageDataDir, { recursive: true })
    fs.writeFileSync(cachePath(paths), JSON.stringify(cache))
  } catch {
    // never fail the command because we could not cache
  }
}
