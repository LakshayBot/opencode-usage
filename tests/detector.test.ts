import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { tmpDir, rmrf } from "./helpers.ts"
import { detectOpenCode } from "../src/opencode/detector.ts"

describe("detectOpenCode", () => {
  it("resolves the first match in PATH order (not the last)", () => {
    const dir1 = tmpDir()
    const dir2 = tmpDir()
    try {
      fs.writeFileSync(path.join(dir1, "opencode"), "#!/bin/sh\n")
      fs.writeFileSync(path.join(dir2, "opencode"), "#!/bin/sh\n")
      const detection = detectOpenCode({ PATH: `${dir1}${path.delimiter}${dir2}` })
      assert.equal(detection.binaryPath, path.join(dir1, "opencode"), "PATH order must win")
      assert.equal(detection.onPath, true)
      assert.equal(detection.found, true)
    } finally {
      rmrf(dir1)
      rmrf(dir2)
    }
  })
})
