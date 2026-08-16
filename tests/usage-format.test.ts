import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { formatCost, formatPercent, formatTokens } from "../src/ui/usage/usage-format.ts"

describe("usage-format", () => {
  it("formatTokens uses compact K/M notation", () => {
    assert.equal(formatTokens(0), "0")
    assert.equal(formatTokens(223), "223")
    assert.equal(formatTokens(1234), "1.2K")
    assert.equal(formatTokens(48623), "48.6K")
    assert.equal(formatTokens(1_200_000), "1.2M")
  })

  it("formatCost keeps precision where appropriate", () => {
    assert.equal(formatCost(0), "$0.00")
    assert.equal(formatCost(12.5), "$12.50")
    assert.equal(formatCost(0.0034), "$0.0034")
    assert.equal(formatCost(0.123), "$0.12")
    assert.equal(formatCost(null), "Unknown")
    assert.equal(formatCost(Number.NaN), "Unknown")
  })

  it("formatPercent is safe when no value exists", () => {
    assert.equal(formatPercent(0.428), "42.8%")
    assert.equal(formatPercent(0), "0.0%")
    assert.equal(formatPercent(null), "N/A")
    assert.equal(formatPercent(undefined), "N/A")
  })
})
