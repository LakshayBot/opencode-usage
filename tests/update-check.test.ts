import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildUpdateNotice, isNewer, parseVersion } from "../src/update/checker.ts"

describe("update checker", () => {
  it("parseVersion extracts major.minor.patch", () => {
    assert.deepEqual(parseVersion("0.1.3"), [0, 1, 3])
    assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3])
    assert.deepEqual(parseVersion("10.20.30-something"), [10, 20, 30])
    assert.equal(parseVersion("not-a-version"), null)
    assert.equal(parseVersion("1.2"), null)
  })

  it("isNewer compares versions correctly", () => {
    assert.equal(isNewer("0.1.4", "0.1.3"), true)
    assert.equal(isNewer("0.2.0", "0.1.9"), true)
    assert.equal(isNewer("1.0.0", "0.9.9"), true)
    assert.equal(isNewer("0.1.3", "0.1.3"), false)
    assert.equal(isNewer("0.1.2", "0.1.3"), false)
    assert.equal(isNewer("garbage", "0.1.3"), false)
    assert.equal(isNewer("0.1.4", "garbage"), false)
  })

  it("buildUpdateNotice includes the upgrade commands", () => {
    const notice = buildUpdateNotice("9.9.9")
    assert.ok(notice.includes("9.9.9"))
    assert.ok(notice.includes("npm install -g @skinnysheep/opencode-usage@latest"))
    assert.ok(notice.includes("opencode-usage install"))
    assert.ok(notice.includes("restart opencode"))
  })
})
