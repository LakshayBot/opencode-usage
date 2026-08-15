/**
 * Detect the opencode installation and version.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface OpenCodeDetection {
  found: boolean
  binaryPath: string | null
  version: string | null
  /** Set when opencode was found on the system PATH. */
  onPath: boolean
}

const CANDIDATE_NAMES = ["opencode", "opencode.exe"]

export function detectOpenCode(env: Record<string, string | undefined> = process.env): OpenCodeDetection {
  const result: OpenCodeDetection = { found: false, binaryPath: null, version: null, onPath: false }

  // 1. PATH lookup
  const pathEnv = env.PATH ?? ""
  const extensions = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""]
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    for (const name of CANDIDATE_NAMES) {
      for (const ext of extensions) {
        const candidate = path.join(dir, name + ext)
        if (fs.existsSync(candidate)) {
          result.binaryPath = candidate
          result.onPath = true
          break
        }
      }
    }
  }

  // 2. Common install locations
  if (!result.binaryPath) {
    const candidates: string[] = []
    const home = env.OPENCODE_TEST_HOME ?? env.HOME ?? os.homedir()
    if (process.platform === "win32") {
      candidates.push(path.join(home, ".opencode", "bin", "opencode.exe"))
    } else {
      candidates.push(path.join(home, ".opencode", "bin", "opencode"))
      candidates.push(path.join(home, ".local", "share", "opencode", "bin", "opencode"))
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        result.binaryPath = candidate
        break
      }
    }
  }

  // 3. Version
  if (result.binaryPath) {
    try {
      const out = execFileSync(result.binaryPath, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      })
      result.version = out.trim().split(/\s+/)[0] ?? null
      result.found = true
    } catch {
      result.found = true
      result.version = null
    }
  }

  return result
}
