import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { pathsFor, testPaths, rmrf } from "./helpers.ts"
import { deploymentNotice, pluginFileHeader } from "../src/opencode/installer.ts"

describe("deploymentNotice", () => {
  it("returns null when nothing is deployed and no opencode config exists", async () => {
    const tp = testPaths()
    try {
      const paths = await pathsFor(tp.env)
      assert.equal(deploymentNotice(paths, "0.1.8"), null)
    } finally {
      rmrf(tp.home)
      rmrf(tp.data)
    }
  })

  it("warns when the integration is not deployed but opencode config exists", async () => {
    const tp = testPaths()
    try {
      const paths = await pathsFor(tp.env)
      fs.mkdirSync(paths.configDir, { recursive: true })
      const notice = deploymentNotice(paths, "0.1.8")
      assert.ok(notice?.includes("not deployed"))
      assert.ok(notice?.includes("opencode-usage install"))
    } finally {
      rmrf(tp.home)
      rmrf(tp.data)
    }
  })

  it("warns when a deployed file is older than the package", async () => {
    const tp = testPaths()
    try {
      const paths = await pathsFor(tp.env)
      fs.mkdirSync(path.dirname(paths.tuiPluginPath), { recursive: true })
      fs.writeFileSync(paths.tuiPluginPath, pluginFileHeader("0.1.2") + "// bundle")
      const notice = deploymentNotice(paths, "0.1.8")
      assert.ok(notice?.includes("v0.1.2"))
      assert.ok(notice?.includes("v0.1.8"))
      assert.ok(notice?.includes("opencode-usage install"))
    } finally {
      rmrf(tp.home)
      rmrf(tp.data)
    }
  })

  it("returns null when both files match the package version", async () => {
    const tp = testPaths()
    try {
      const paths = await pathsFor(tp.env)
      fs.mkdirSync(path.dirname(paths.serverPluginPath), { recursive: true })
      fs.writeFileSync(paths.serverPluginPath, pluginFileHeader("0.1.8") + "// bundle")
      fs.writeFileSync(paths.tuiPluginPath, pluginFileHeader("0.1.8") + "// bundle")
      assert.equal(deploymentNotice(paths, "0.1.8"), null)
    } finally {
      rmrf(tp.home)
      rmrf(tp.data)
    }
  })

  it("warns on partial deployment", async () => {
    const tp = testPaths()
    try {
      const paths = await pathsFor(tp.env)
      fs.mkdirSync(path.dirname(paths.serverPluginPath), { recursive: true })
      fs.writeFileSync(paths.serverPluginPath, pluginFileHeader("0.1.8") + "// bundle")
      const notice = deploymentNotice(paths, "0.1.8")
      assert.ok(notice?.includes("partially deployed"))
    } finally {
      rmrf(tp.home)
      rmrf(tp.data)
    }
  })

  it("ignores files it does not own", async () => {
    const tp = testPaths()
    try {
      const paths = await pathsFor(tp.env)
      fs.mkdirSync(path.dirname(paths.serverPluginPath), { recursive: true })
      fs.writeFileSync(paths.serverPluginPath, "// someone elses plugin\nexport default {}")
      // Not ours -> treated as not deployed (config dir exists -> notice)
      const notice = deploymentNotice(paths, "0.1.8")
      assert.ok(notice?.includes("not deployed") || notice === null)
    } finally {
      rmrf(tp.home)
      rmrf(tp.data)
    }
  })
})
