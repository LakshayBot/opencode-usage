import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildUsageModels,
  buildUsageOverview,
  buildUsagePeriodSummaries,
  buildUsageProviders,
} from "../src/ui/usage/usage-view-model.ts"
import type { UsageReport } from "../src/types/usage.ts"

function makeReport(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    period: { kind: "all" },
    periodLabel: "All Time",
    counts: {
      userMessages: 0,
      assistantMessages: 0,
      modelRequests: 0,
      sessions: 0,
      mainAgentRequests: 0,
      subagentRequests: 0,
      systemRequests: 0,
    },
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, grossInput: 0 },
    cache: { available: false, hitRate: null, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedSavings: null },
    cost: {
      exact: null,
      breakdown: { input: null, output: null, cacheRead: null, cacheWrite: null },
      total: null,
      unknown: false,
    },
    perModel: [],
    perProvider: [],
    averages: { inputTokensPerUserMessage: null, outputTokensPerAssistantResponse: null },
    topModels: { mostUsed: null, mostExpensive: null },
    largestRequest: null,
    tracking: { startedAt: null, lastActivity: null },
    ...overrides,
  }
}

describe("buildUsageOverview", () => {
  it("maps counts, tokens and period into a presentation model", () => {
    const report = makeReport({
      periodLabel: "Today",
      counts: { userMessages: 2, assistantMessages: 1, modelRequests: 3, sessions: 1, mainAgentRequests: 3, subagentRequests: 0, systemRequests: 0 },
      tokens: { input: 3000, output: 800, reasoning: 100, cacheRead: 13000, cacheWrite: 300, total: 17100, grossInput: 16300 },
      cache: { available: true, hitRate: 13000 / 16300, cacheReadTokens: 13000, cacheWriteTokens: 300, estimatedSavings: 0.01 },
      perModel: [{ provider: "anthropic", model: "claude-sonnet-4-6", requests: 3, totalTokens: 17100, inputTokens: 3000, outputTokens: 800, cost: 0.03 }],
      perProvider: [{ provider: "anthropic", requests: 3, totalTokens: 17100, cost: 0.03 }],
    })

    const view = buildUsageOverview(report)
    assert.equal(view.periodLabel, "Today")
    assert.equal(view.messages, 3)
    assert.equal(view.requests, 3)
    assert.equal(view.totalTokens, 17100)
    assert.equal(view.inputTokens, 3000)
    assert.equal(view.outputTokens, 800)
    assert.equal(view.reasoningTokens, 100)
    assert.equal(view.cacheReadTokens, 13000)
    assert.equal(view.cacheWriteTokens, 300)
    assert.equal(view.cacheAvailable, true)
    assert.equal(view.cacheHitRate, 13000 / 16300)
    assert.equal(view.modelCount, 1)
    assert.equal(view.providerCount, 1)
    assert.equal(view.hasData, true)
  })

  it("prefers the breakdown total when pricing is known", () => {
    const report = makeReport({
      cost: { exact: 0.5, breakdown: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.02 }, total: 0.37, unknown: false },
    })
    assert.equal(buildUsageOverview(report).cost, 0.37)
  })

  it("falls back to the opencode-computed cost when pricing is unknown", () => {
    const report = makeReport({
      cost: { exact: 0.5, breakdown: { input: null, output: null, cacheRead: null, cacheWrite: null }, total: null, unknown: true },
    })
    assert.equal(buildUsageOverview(report).cost, 0.5)
  })

  it("reports unknown when no cost signal exists", () => {
    const report = makeReport({
      cost: { exact: null, breakdown: { input: null, output: null, cacheRead: null, cacheWrite: null }, total: null, unknown: true },
    })
    assert.equal(buildUsageOverview(report).cost, null)
  })

  it("empty report has hasData=false", () => {
    assert.equal(buildUsageOverview(makeReport()).hasData, false)
  })
})

describe("buildUsageModels / buildUsageProviders", () => {
  it("maps per-model and per-provider rows", () => {
    const report = makeReport({
      perModel: [{ provider: "anthropic", model: "claude-sonnet-4-6", requests: 3, totalTokens: 17100, inputTokens: 3000, outputTokens: 800, cost: 0.03 }],
      perProvider: [{ provider: "anthropic", requests: 3, totalTokens: 17100, cost: 0.03 }],
    })
    const models = buildUsageModels(report)
    assert.equal(models[0]!.model, "claude-sonnet-4-6")
    assert.equal(models[0]!.provider, "anthropic")
    assert.equal(models[0]!.inputTokens, 3000)
    const providers = buildUsageProviders(report)
    assert.equal(providers[0]!.provider, "anthropic")
    assert.equal(providers[0]!.totalTokens, 17100)
  })
})

describe("buildUsagePeriodSummaries", () => {
  it("builds one summary per report, reusing the overview cost signal", () => {
    const summaries = buildUsagePeriodSummaries([
      makeReport({ period: { kind: "today" }, periodLabel: "Today" }),
      makeReport({ period: { kind: "all" }, periodLabel: "All Time" }),
    ])
    assert.equal(summaries.length, 2)
    assert.deepEqual(summaries[0]!.period, { kind: "today" })
    assert.equal(summaries[0]!.label, "Today")
    assert.equal(summaries[1]!.label, "All Time")
    assert.equal(summaries[1]!.cost, null)
  })
})
