import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { CostCalculator, CatalogPricingProvider } from "../src/pricing/cost-calculator.ts"
import { PRICING_CATALOG } from "../src/pricing/pricing-catalog.ts"
import { extractEntries, importPricingRows, syncPricingFromModelsDev } from "../src/pricing/modelsdev.ts"
import { UsageDatabase } from "../src/storage/database.ts"
import { tmpDir, rmrf } from "./helpers.ts"
import path from "node:path"

function pricing(overrides: Partial<Record<string, number | null>> = {}) {
  return {
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    cacheReadPricePerMillion: 0.3,
    cacheWritePricePerMillion: 3.75,
    effectiveFrom: 0,
    effectiveUntil: null,
    source: "catalog",
    ...overrides,
  }
}

describe("CostCalculator", () => {
  it("computes component costs per the spec formulas", () => {
    const calc = CostCalculator.compute(
      { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000 },
      pricing(),
    )
    assert.equal(calc.input, 3)
    assert.equal(calc.output, 7.5)
    assert.equal(calc.cacheRead, 0.6)
    assert.equal(calc.cacheWrite, 0.375)
    assert.equal(calc.total, 3 + 7.5 + 0.6 + 0.375)
    assert.equal(calc.unknown, false)
  })

  it("charges reasoning tokens at the output rate", () => {
    const calc = CostCalculator.compute({ inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, pricing())
    const withReasoning = CostCalculator.compute(
      { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      pricing(),
    )
    // (output+reasoning) is folded by the caller (forEvent); here compute() takes outputTokens already combined
    assert.equal(calc.output, withReasoning.output)
    assert.equal(calc.output, 1.5)
  })

  it("returns unknown when no pricing exists", () => {
    const calc = CostCalculator.compute(
      { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      null,
    )
    assert.equal(calc.total, null)
    assert.equal(calc.input, null)
    assert.equal(calc.unknown, true)
  })

  it("returns unknown when a component price is missing", () => {
    const calc = CostCalculator.compute(
      { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      pricing({ cacheWritePricePerMillion: null }),
    )
    assert.equal(calc.total, null)
    assert.equal(calc.unknown, true)
  })

  it("is exact about zero tokens", () => {
    const calc = CostCalculator.compute(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      pricing(),
    )
    assert.equal(calc.total, 0)
  })
})

describe("CatalogPricingProvider", () => {
  it("finds anthropic cache pricing", () => {
    const provider = new CatalogPricingProvider()
    const p = provider.getPricing("anthropic", "claude-sonnet-4-6", Date.now())
    assert.ok(p)
    assert.equal(p.cacheReadPricePerMillion, 0.3)
    assert.equal(p.cacheWritePricePerMillion, 3.75)
  })

  it("returns null for unknown models (never invented)", () => {
    const provider = new CatalogPricingProvider()
    assert.equal(provider.getPricing("anthropic", "claude-nope", Date.now()), null)
    assert.equal(provider.getPricing("unknown-provider", "any", Date.now()), null)
  })

  it("catalog is well-formed", () => {
    for (const [provider, models] of Object.entries(PRICING_CATALOG)) {
      assert.ok(provider.length > 0)
      for (const [model, entry] of Object.entries(models)) {
        assert.ok(model.length > 0)
        assert.ok(entry.inputPricePerMillion === null || typeof entry.inputPricePerMillion === "number")
        assert.ok(entry.outputPricePerMillion === null || typeof entry.outputPricePerMillion === "number")
      }
    }
  })
})

describe("models.dev sync", () => {
  const fixture = {
    anthropic: {
      id: "anthropic",
      models: {
        "claude-sonnet-4-6": {
          id: "claude-sonnet-4-6",
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        },
        "claude-3-5-haiku": {
          id: "claude-3-5-haiku",
          cost: { input: 0.8, output: 4 },
        },
      },
    },
    openai: {
      id: "openai",
      models: {
        "gpt-4o": { id: "gpt-4o", cost: { input: 2.5, output: 10 } },
      },
    },
  }

  it("extracts pricing entries from the models.dev shape", () => {
    const entries = extractEntries(fixture as never)
    assert.equal(entries.length, 3)
    const sonnet = entries.find((e) => e.model === "claude-sonnet-4-6")
    assert.ok(sonnet)
    assert.equal(sonnet.cost.cacheRead, 0.3)
  })

  it("imports rows and skips duplicates on re-sync", async () => {
    const dir = tmpDir()
    try {
      const db = UsageDatabase.open(path.join(dir, "usage.db"))
      const first = await syncPricingFromModelsDev(db, async () => new Response(JSON.stringify(fixture)) as never)
      assert.equal(first.imported, 3)
      const second = await syncPricingFromModelsDev(db, async () => new Response(JSON.stringify(fixture)) as never)
      assert.equal(second.imported, 0)
      assert.equal(second.skipped, 3)
      db.close()
    } finally {
      rmrf(dir)
    }
  })

  it("stores rows with effective_from for historical pricing", async () => {
    const dir = tmpDir()
    try {
      const db = UsageDatabase.open(path.join(dir, "usage.db"))
      const now = Date.now()
      const imported = importPricingRows(db, extractEntries(fixture as never), now)
      assert.equal(imported, 3)
      // query with a timestamp before effective_from -> no match
      const before = db.raw
        .prepare("SELECT COUNT(*) AS n FROM pricing_history WHERE effective_from <= ?")
        .get(now - 1) as { n: number }
      assert.equal(before.n, 0)
      const after = db.raw
        .prepare("SELECT COUNT(*) AS n FROM pricing_history WHERE effective_from <= ?")
        .get(now) as { n: number }
      assert.equal(after.n, 3)
      db.close()
    } finally {
      rmrf(dir)
    }
  })
})
