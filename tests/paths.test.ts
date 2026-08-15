import { describe, it } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { pathsFor } from "./helpers.ts"

describe("platform path resolution", () => {
  const base = {
    HOME: "/home/test-user",
    XDG_DATA_HOME: "/home/test-user/.local/share",
    XDG_CONFIG_HOME: "/home/test-user/.config",
  }

  it("resolves macOS/Linux xdg paths", async () => {
    const paths = await pathsFor({ ...base })
    assert.equal(paths.configDir, "/home/test-user/.config/opencode")
    assert.equal(paths.opencodeDataDir, "/home/test-user/.local/share/opencode")
    assert.equal(paths.usageDataDir, "/home/test-user/.local/share/opencode-usage")
    assert.equal(paths.usageDbPath, "/home/test-user/.local/share/opencode-usage/usage.db")
    assert.equal(paths.serverPluginPath, "/home/test-user/.config/opencode/plugin/opencode-usage.js")
    assert.equal(paths.tuiPluginPath, "/home/test-user/.config/opencode/opencode-usage.tui.js")
    assert.equal(paths.tuiConfigPath, "/home/test-user/.config/opencode/tui.json")
    assert.equal(paths.commandPath, "/home/test-user/.config/opencode/commands/usage.md")
  })

  it("falls back to HOME when XDG vars are unset", async () => {
    const paths = await pathsFor({ HOME: "/home/user" })
    assert.equal(paths.configDir, path.join("/home/user", ".config", "opencode"))
    assert.equal(paths.usageDataDir, path.join("/home/user", ".local", "share", "opencode-usage"))
  })

  it("honors OPENCODE_CONFIG_DIR", async () => {
    const paths = await pathsFor({ ...base, OPENCODE_CONFIG_DIR: "/custom/config" })
    assert.equal(paths.configDir, "/custom/config")
  })

  it("resolves Windows paths from APPDATA/LOCALAPPDATA", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      const paths = await pathsFor({
        HOME: "C:\\Users\\t",
        APPDATA: "C:\\Users\\t\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local",
      })
      // path.join uses the host separators; normalize for cross-platform asserts.
      const asWin = (p: string) => p.replaceAll("/", "\\")
      assert.equal(asWin(paths.configDir), "C:\\Users\\t\\AppData\\Roaming\\opencode")
      assert.equal(asWin(paths.opencodeDataDir), "C:\\Users\\t\\AppData\\Local\\opencode")
      assert.equal(asWin(paths.usageDbPath), "C:\\Users\\t\\AppData\\Local\\opencode-usage\\usage.db")
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
    }
  })

  it("XDG vars win over APPDATA on Windows (xdg-basedir semantics)", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      const paths = await pathsFor({
        HOME: "C:\\Users\\t",
        XDG_CONFIG_HOME: "C:\\xdg\\config",
        XDG_DATA_HOME: "C:\\xdg\\data",
        APPDATA: "C:\\Users\\t\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local",
      })
      const asWin = (p: string) => p.replaceAll("/", "\\")
      assert.equal(asWin(paths.configDir), "C:\\xdg\\config\\opencode")
      assert.equal(asWin(paths.usageDataDir), "C:\\xdg\\data\\opencode-usage")
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
    }
  })
})
