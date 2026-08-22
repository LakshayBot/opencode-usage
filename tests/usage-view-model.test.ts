import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildComparisonModel,
  buildUsageAgents,
  buildUsageModels,
  buildUsageOverview,
  buildUsagePeriodSummaries,
  buildUsageProjects,
  buildUsageProviders,
} from "../src/ui/usage/usage-view-model.ts"
import type { PeriodComparison } from "../src/reporting/usage-report.ts"
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
    perAgent: [],
    perProject: [],
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

describe("buildUsageAgents / buildUsageProjects", () => {
  it("maps per-agent rows through unchanged", () => {
    const report = makeReport({
      perAgent: [
        { agent: "build", requests: 3, totalTokens: 17100, inputTokens: 3000, outputTokens: 800, cost: 0.03 },
        { agent: "explore", requests: 1, totalTokens: 900, inputTokens: 800, outputTokens: 100, cost: null },
      ],
    })
    const agents = buildUsageAgents(report)
    assert.deepEqual(agents, [
      { agent: "build", requests: 3, totalTokens: 17100, inputTokens: 3000, outputTokens: 800, cost: 0.03 },
      { agent: "explore", requests: 1, totalTokens: 900, inputTokens: 800, outputTokens: 100, cost: null },
    ])
  })

  it("maps per-project rows through unchanged", () => {
    const report = makeReport({
      perProject: [{ project: "(no project)", requests: 2, totalTokens: 1200, inputTokens: 1100, outputTokens: 100, cost: 0.01 }],
    })
    assert.deepEqual(buildUsageProjects(report), [
      { project: "(no project)", requests: 2, totalTokens: 1200, inputTokens: 1100, outputTokens: 100, cost: 0.01 },
    ])
  })

  it("empty grouping arrays map to empty view models", () => {
    assert.deepEqual(buildUsageAgents(makeReport()), [])
    assert.deepEqual(buildUsageProjects(makeReport()), [])
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

describe("buildComparisonModel", () => {
  function makeCmp(overrides: Partial<PeriodComparison> = {}): PeriodComparison {
    return {
      available: true,
      label: "Last 7 Days",
      current: { requests: 134, totalTokens: 1000, cost: 2 },
      previous: { requests: 100, totalTokens: 750, cost: 3 },
      delta: { requestsPct: 34, totalTokensPct: 33, costPct: -33 },
      ...overrides,
    }
  }

  it("renders up, down and composed line with the period label", () => {
    const model = buildComparisonModel(makeCmp())
    assert.equal(model.available, true)
    assert.equal(model.requestsText, "+34%")
    assert.equal(model.totalTokensText, "+33%")
    assert.equal(model.costText, "-33%")
    assert.equal(model.text, "vs prev Last 7 Days: req +34% · tok +33% · cost -33%")
  })

  it("renders em dash for null pcts (including unknown costs)", () => {
    const model = buildComparisonModel(
      makeCmp({
        delta: { requestsPct: null, totalTokensPct: -12, costPct: null },
        current: { requests: 0, totalTokens: 660, cost: null },
      }),
    )
    assert.equal(model.requestsText, "—")
    assert.equal(model.totalTokensText, "-12%")
    assert.equal(model.costText, "—")
    assert.equal(model.text, "vs prev Last 7 Days: req — · tok -12% · cost —")
  })

  it("renders 'new' when usage appears from a zero previous window", () => {
    const model = buildComparisonModel(
      makeCmp({
        previous: { requests: 0, totalTokens: 0, cost: 0 },
        delta: { requestsPct: null, totalTokensPct: null, costPct: null },
      }),
    )
    assert.equal(model.requestsText, "new")
    assert.equal(model.totalTokensText, "new")
    // zero-to-zero is not 'new', just not comparable
    const flat = buildComparisonModel(
      makeCmp({ current: { requests: 0, totalTokens: 0, cost: 0 }, delta: { requestsPct: null, totalTokensPct: null, costPct: null } }),
    )
    assert.equal(flat.requestsText, "—")
    // an unknown current cost is never comparable, so it stays '—', never 'new'
    const unknownCost = buildComparisonModel(
      makeCmp({ current: { requests: 5, totalTokens: 5, cost: null }, delta: { requestsPct: null, totalTokensPct: null, costPct: null } }),
    )
    assert.equal(unknownCost.costText, "—")
  })

  it("renders '+0%' for an unchanged metric and hides everything when unavailable", () => {
    const unchanged = buildComparisonModel(makeCmp({ delta: { requestsPct: 0, totalTokensPct: 0, costPct: 0 } }))
    assert.equal(unchanged.text, "vs prev Last 7 Days: req +0% · tok +0% · cost +0%")

    const hidden = buildComparisonModel(makeCmp({ available: false }))
    assert.equal(hidden.available, false)
    assert.equal(hidden.text, "")
  })
})
