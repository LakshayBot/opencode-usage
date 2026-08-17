import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { tmpDir, rmrf, pathsFor } from "./helpers.ts"
import {
  install,
  uninstall,
  status,
  usageCommandMarkdown,
  ensureTuiConfigEntry,
  removeTuiConfigEntry,
  isOwnedPluginFile,
  pathToFileUrlSpec,
} from "../src/opencode/installer.ts"

const VERSION = "0.1.0"
const PLUGIN_SOURCE = "export const x = 1\n"

async function makeEnv() {
  const home = tmpDir("ocu-inst-home-")
  const data = tmpDir("ocu-inst-data-")
  const env = {
    HOME: home,
    XDG_DATA_HOME: path.join(data, "d"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(data, "s"),
    XDG_CACHE_HOME: path.join(data, "c"),
  }
  const paths = await pathsFor(env)
  return { env, paths, home, data }
}

describe("installer", () => {
  it("installs all artifacts and is idempotent", async () => {
    const { paths, home } = await makeEnv()
    try {
      const first = install(paths, VERSION, {
        serverPluginContent: PLUGIN_SOURCE,
        tuiPluginContent: PLUGIN_SOURCE,
      })
      assert.equal(first.serverPlugin, "written")
      assert.equal(first.tuiPlugin, "written")
      assert.equal(first.tuiConfig, "created")
      assert.equal(first.command, "none")
      assert.ok(fs.existsSync(paths.usageDbPath))

      // Second install: nothing changes.
      const second = install(paths, VERSION, {
        serverPluginContent: PLUGIN_SOURCE,
        tuiPluginContent: PLUGIN_SOURCE,
      })
      assert.equal(second.serverPlugin, "already-up-to-date")
      assert.equal(second.tuiPlugin, "already-up-to-date")
      assert.equal(second.tuiConfig, "already-present")
      assert.equal(second.command, "none")

      assert.ok(fs.existsSync(paths.serverPluginPath))
      assert.ok(fs.readFileSync(paths.serverPluginPath, "utf8").startsWith("// opencode-usage:installed"))
      assert.ok(fs.existsSync(paths.tuiPluginPath))
      // No server command file: /usage is the TUI popup (one palette entry).
      assert.ok(!fs.existsSync(paths.commandPath))

      // tui.json points at the tui plugin via file:// spec.
      const tuiConfig = JSON.parse(fs.readFileSync(paths.tuiConfigPath, "utf8")) as { plugin: string[] }
      assert.deepEqual(tuiConfig.plugin, [pathToFileUrlSpec(paths.tuiPluginPath)])
      assert.ok(home.length > 0)
    } finally {
      rmrf(home)
    }
  })

  it("preserves existing tui.json content when merging", async () => {
    const { paths, home } = await makeEnv()
    try {
      fs.mkdirSync(path.dirname(paths.tuiConfigPath), { recursive: true })
      fs.writeFileSync(paths.tuiConfigPath, JSON.stringify({ theme: "custom", plugin: ["opencode-other"] }, null, 2))
      const result = install(paths, VERSION, { serverPluginContent: PLUGIN_SOURCE, tuiPluginContent: PLUGIN_SOURCE })
      assert.equal(result.tuiConfig, "updated")
      const parsed = JSON.parse(fs.readFileSync(paths.tuiConfigPath, "utf8")) as Record<string, unknown>
      assert.equal(parsed.theme, "custom")
      const plugins = parsed.plugin as string[]
      assert.equal(plugins.length, 2)
      assert.ok(plugins.includes("opencode-other"))
      assert.ok(plugins.includes(pathToFileUrlSpec(paths.tuiPluginPath)))
    } finally {
      rmrf(home)
    }
  })

  it("reports an error for unparseable tui.json without breaking the rest", async () => {
    const { paths, home } = await makeEnv()
    try {
      fs.mkdirSync(path.dirname(paths.tuiConfigPath), { recursive: true })
      fs.writeFileSync(paths.tuiConfigPath, "// jsonc with comments\n{ \"plugin\": [] }")
      const result = install(paths, VERSION, { serverPluginContent: PLUGIN_SOURCE, tuiPluginContent: PLUGIN_SOURCE })
      assert.equal(result.tuiConfig, "error")
      assert.ok(result.tuiConfigError?.includes("manually"))
      // Everything else still installed.
      assert.equal(result.serverPlugin, "written")
      assert.equal(result.command, "none")
      assert.ok(!fs.existsSync(paths.commandPath))
    } finally {
      rmrf(home)
    }
  })

  it("removes a legacy command file from an old install (healing)", async () => {
    const { paths, home } = await makeEnv()
    try {
      fs.mkdirSync(path.dirname(paths.commandPath), { recursive: true })
      fs.writeFileSync(paths.commandPath, usageCommandMarkdown())
      const result = install(paths, VERSION, { serverPluginContent: PLUGIN_SOURCE, tuiPluginContent: PLUGIN_SOURCE })
      assert.equal(result.command, "removed")
      assert.ok(!fs.existsSync(paths.commandPath), "legacy usage.md must be deleted")
    } finally {
      rmrf(home)
    }
  })

  it("uninstalls only its own files and keeps history", async () => {
    const { paths, home } = await makeEnv()
    try {
      install(paths, VERSION, { serverPluginContent: PLUGIN_SOURCE, tuiPluginContent: PLUGIN_SOURCE })
      // user file next to ours must survive
      fs.writeFileSync(paths.commandPath.replace("usage.md", "mycommand.md"), "# user command\n")
      // legacy command file from an old install must be removed on uninstall
      fs.mkdirSync(path.dirname(paths.commandPath), { recursive: true })
      fs.writeFileSync(paths.commandPath, usageCommandMarkdown())
      const foreign = path.join(path.dirname(paths.serverPluginPath), "user-plugin.js")
      fs.writeFileSync(foreign, "export default {}\n")

      const result = uninstall(paths, { purge: false })
      assert.equal(result.serverPlugin, "removed")
      assert.equal(result.tuiPlugin, "removed")
      assert.equal(result.tuiConfig, "removed")
      assert.equal(result.command, "removed")
      assert.equal(result.database, "kept")
      assert.ok(fs.existsSync(paths.usageDbPath), "database preserved")
      assert.ok(fs.existsSync(foreign), "foreign plugin preserved")
      assert.ok(fs.existsSync(paths.commandPath.replace("usage.md", "mycommand.md")))
    } finally {
      rmrf(home)
    }
  })

  it("never removes files it does not own", async () => {
    const { paths, home } = await makeEnv()
    try {
      fs.mkdirSync(path.dirname(paths.serverPluginPath), { recursive: true })
      fs.writeFileSync(paths.serverPluginPath, "// someone else's plugin\n")
      const result = uninstall(paths, { purge: false })
      assert.equal(result.serverPlugin, "skipped-not-ours")
      assert.ok(fs.existsSync(paths.serverPluginPath))
    } finally {
      rmrf(home)
    }
  })

  it("purge removes the database only with explicit flag", async () => {
    const { paths, home } = await makeEnv()
    try {
      install(paths, VERSION, { serverPluginContent: PLUGIN_SOURCE, tuiPluginContent: PLUGIN_SOURCE })
      const kept = uninstall(paths, { purge: false })
      assert.equal(kept.database, "kept")
      assert.ok(fs.existsSync(paths.usageDbPath))
      const purged = uninstall(paths, { purge: true })
      assert.equal(purged.database, "removed")
      assert.ok(!fs.existsSync(paths.usageDbPath))
    } finally {
      rmrf(home)
    }
  })

  it("status reports installation state", async () => {
    const { paths, home } = await makeEnv()
    try {
      const before = status(paths, { detected: true, binaryPath: "/bin/opencode", version: "1.18.18" }, VERSION)
      assert.equal(before.serverPlugin, false)
      install(paths, VERSION, { serverPluginContent: PLUGIN_SOURCE, tuiPluginContent: PLUGIN_SOURCE })
      const after = status(paths, { detected: true, binaryPath: "/bin/opencode", version: "1.18.18" }, VERSION)
      assert.equal(after.serverPlugin, true)
      assert.equal(after.tuiPlugin, true)
      assert.equal(after.tuiConfig, true)
      assert.equal(after.command, false, "no /usage command file is installed")
      assert.equal(after.databaseExists, true)
      assert.equal(after.trackedMessages, 0)
    } finally {
      rmrf(home)
    }
  })
})

describe("tui.json entry management", () => {
  it("creates, dedupes, and removes entries", async () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, "tui.json")
      assert.equal(ensureTuiConfigEntry(file, "file:///a.js").state, "created")
      assert.equal(ensureTuiConfigEntry(file, "file:///a.js").state, "already-present")
      assert.equal(ensureTuiConfigEntry(file, "file:///b.js").state, "updated")
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { plugin: string[] }
      assert.deepEqual(parsed.plugin, ["file:///a.js", "file:///b.js"])

      assert.equal(removeTuiConfigEntry(file, "file:///a.js"), "removed")
      assert.equal(removeTuiConfigEntry(file, "file:///a.js"), "missing")
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as { plugin: string[] }
      assert.deepEqual(after.plugin, ["file:///b.js"])
    } finally {
      rmrf(dir)
    }
  })

  it("removes the file when only our entry remains", async () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, "tui.json")
      ensureTuiConfigEntry(file, "file:///a.js")
      assert.equal(removeTuiConfigEntry(file, "file:///a.js"), "removed")
      assert.ok(!fs.existsSync(file))
    } finally {
      rmrf(dir)
    }
  })
})

describe("ownership markers", () => {
  it("recognizes installed plugin files", () => {
    assert.ok(isOwnedPluginFile("// opencode-usage:installed v0.1.0 — managed by opencode-usage. Do not edit.\ncode"))
    assert.ok(!isOwnedPluginFile("export const foo = 1\n"))
  })

  it("recognizes our command file", () => {
    const md = usageCommandMarkdown()
    assert.ok(md.includes("`usage` tool"))
    assert.ok(md.includes("$ARGUMENTS"))
    assert.ok(md.startsWith("---"))
  })
})

describe("pathToFileUrlSpec (cross-platform)", () => {
  it("produces POSIX file URLs unchanged", () => {
    assert.equal(
      pathToFileUrlSpec("/Users/john/.config/opencode/opencode-usage.tui.js"),
      "file:///Users/john/.config/opencode/opencode-usage.tui.js",
    )
  })

  it("builds valid Windows drive-letter file URLs (the pre-0.1.5 bug)", () => {
    const spec = pathToFileUrlSpec("C:\\Users\\John Doe\\AppData\\Roaming\\opencode\\opencode-usage.tui.js")
    // Drive letter keeps its colon and the URL gets a third slash.
    assert.equal(spec, "file:///C:/Users/John%20Doe/AppData/Roaming/opencode/opencode-usage.tui.js")
    // It must not parse with the drive letter as the URL host.
    assert.equal(new URL(spec).hostname, "")
    assert.equal(new URL(spec).pathname, "/C:/Users/John%20Doe/AppData/Roaming/opencode/opencode-usage.tui.js")
  })

  it("handles UNC paths", () => {
    assert.equal(
      pathToFileUrlSpec("\\\\server\\share\\opencode-usage.tui.js"),
      "file://server/share/opencode-usage.tui.js",
    )
  })
})

describe("legacy broken Windows tui.json entries", () => {
  const LEGACY = "file://C/Users/john/AppData/Roaming/opencode/opencode-usage.tui.js"
  const CORRECT = "file:///C:/Users/john/AppData/Roaming/opencode/opencode-usage.tui.js"

  it("replaces a legacy spec in place on reinstall", () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, "tui.json")
      ensureTuiConfigEntry(file, LEGACY)
      const result = ensureTuiConfigEntry(file, CORRECT)
      assert.equal(result.state, "updated")
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { plugin: string[] }
      assert.deepEqual(parsed.plugin, [CORRECT], "no duplicate entry may remain")
    } finally {
      rmrf(dir)
    }
  })

  it("removes a legacy spec on uninstall", () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, "tui.json")
      ensureTuiConfigEntry(file, LEGACY)
      assert.equal(removeTuiConfigEntry(file, CORRECT), "removed")
      assert.ok(!fs.existsSync(file))
    } finally {
      rmrf(dir)
    }
  })

  it("status counts a legacy spec as installed", async () => {
    const dir = tmpDir()
    try {
      const file = path.join(dir, "tui.json")
      ensureTuiConfigEntry(file, LEGACY)
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { plugin: string[] }
      assert.equal(parsed.plugin[0], LEGACY)
      // The plugin path is a Windows path (as on a real Windows machine);
      // status() must derive a spec matching the legacy tui.json entry.
      const fakePaths = {
        serverPluginPath: path.join(dir, "opencode-usage.js"),
        tuiPluginPath: "C:\\Users\\john\\AppData\\Roaming\\opencode\\opencode-usage.tui.js",
        tuiConfigPath: file,
        commandPath: path.join(dir, "usage.md"),
        usageDbPath: path.join(dir, "usage.db"),
        usageDataDir: dir,
      }
      const st = status(fakePaths as never, { detected: true, binaryPath: "opencode", version: "1.18.18" }, "0.1.5")
      assert.equal(st.tuiConfig, true, "legacy spec must count as installed")
    } finally {
      rmrf(dir)
    }
  })
})
