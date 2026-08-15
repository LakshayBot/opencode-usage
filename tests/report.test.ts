import { describe, it } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { tmpDir, rmrf, seedUsageEvents } from "./helpers.ts"
import { UsageDatabase } from "../src/storage/database.ts"
import { computeReport, periodRange, periodLabel } from "../src/reporting/usage-report.ts"
import { HybridPricingProvider } from "../src/pricing/modelsdev.ts"
import { renderReportMarkdown, formatTokens, formatCost } from "../src/reporting/formatters/markdown.ts"
import type { UsageReport } from "../src/types/usage.ts"

describe("computeReport", () => {
  const now = Date.now()

  function setup(): string {
    const dir = tmpDir()
    const dbPath = path.join(dir, "usage.db")
    seedUsageEvents(dbPath, now)
    // add message + session rows
    const db = UsageDatabase.open(dbPath)
    db.insertMessageRecord({ eventKey: "ocm:user:m1", timestamp: now - 3600_000, sessionId: "ses_x", messageId: "m1", role: "user", agent: "build" })
    db.insertMessageRecord({ eventKey: "ocm:assistant:m2", timestamp: now - 3600_000, sessionId: "ses_x", messageId: "m2", role: "assistant", agent: "build" })
    db.upsertSessionRecord({ id: "ses_x", projectId: "proj_x", created: now - 7200_000, updated: now - 3600_000 })
    db.upsertSessionRecord({ id: "ses_old", projectId: "proj_y", created: now - 60 * 24 * 3600_000, updated: now - 59 * 24 * 3600_000 })
    db.close()
    return dbPath
  }

  function reportFor(dbPath: string, period: Parameters<typeof computeReport>[1]): UsageReport {
    const db = UsageDatabase.open(dbPath, { readOnly: true })
    try {
      return computeReport(db, period, {}, { pricing: new HybridPricingProvider(db), now })
    } finally {
      db.close()
    }
  }

  it("aggregates the current-session period", () => {
    const dbPath = setup()
    const report = reportFor(dbPath, { kind: "session", sessionId: "ses_x" })
    assert.equal(report.counts.modelRequests, 2)
    assert.equal(report.counts.userMessages, 1)
    assert.equal(report.counts.assistantMessages, 1)
    assert.equal(report.counts.sessions, 1)
    assert.equal(report.tokens.input, 3000)
    assert.equal(report.tokens.output, 800)
    assert.equal(report.tokens.cacheRead, 13000)
    assert.equal(report.cache.hitRate, 13000 / (13000 + 3000))
    assert.equal(report.perModel.length, 1)
    assert.equal(report.perModel[0]!.model, "claude-sonnet-4-6")
    assert.equal(report.cost.unknown, false)
    assert.equal(report.cost.exact, 0.03)
    rmrf(path.dirname(dbPath))
  })

  it("week excludes old events, month/all include them", () => {
    const dbPath = setup()
    const week = reportFor(dbPath, { kind: "week" })
    assert.equal(week.counts.modelRequests, 2)
    assert.equal(week.counts.sessions, 1)
    const month = reportFor(dbPath, { kind: "month" })
    assert.equal(month.counts.modelRequests, 3)
    const all = reportFor(dbPath, { kind: "all" })
    assert.equal(all.counts.modelRequests, 3)
    assert.equal(all.counts.sessions, 2)
    rmrf(path.dirname(dbPath))
  })

  it("today only includes today's events", () => {
    const dbPath = setup()
    const today = reportFor(dbPath, { kind: "today" })
    assert.equal(today.counts.modelRequests, 2)
    rmrf(path.dirname(dbPath))
  })

  it("tracks main/subagent/system agent breakdown", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const db = UsageDatabase.open(dbPath)
      const t = now
      const insert = db.raw.prepare(
        `INSERT INTO usage_events (event_key, timestamp, session_id, agent, parent_session_id, provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, provider_reported_cache)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 0, 2, 0.01, 0)`,
      )
      insert.run("e1", t, "s_main", "build", null, "anthropic", "m")
      insert.run("e2", t, "s_sub", "explore", "s_main", "anthropic", "m")
      insert.run("e3", t, "s_comp", "compaction", null, "anthropic", "m")
      db.close()

      const report = reportFor(dbPath, { kind: "all" })
      assert.equal(report.counts.mainAgentRequests, 1)
      assert.equal(report.counts.subagentRequests, 1)
      assert.equal(report.counts.systemRequests, 1)
    } finally {
      rmrf(dir)
    }
  })

  it("shows cache as unavailable when no cache-reporting events exist", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const db = UsageDatabase.open(dbPath)
      const t = now
      const insert = db.raw.prepare(
        `INSERT INTO usage_events (event_key, timestamp, session_id, provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, provider_reported_cache)
         VALUES (?, ?, ?, ?, ?, 10, 5, 0, 0, 15, 0.01, 0)`,
      )
      insert.run("e1", t, "s1", "mistral", "mistral-large")
      db.close()
      const report = reportFor(dbPath, { kind: "all" })
      assert.equal(report.cache.available, false)
      assert.equal(report.cache.hitRate, null)
    } finally {
      rmrf(dir)
    }
  })

  it("reports unknown cost when pricing is missing for a model", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const db = UsageDatabase.open(dbPath)
      const t = now
      const insert = db.raw.prepare(
        `INSERT INTO usage_events (event_key, timestamp, session_id, provider, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, provider_reported_cache)
         VALUES (?, ?, ?, ?, ?, 100, 10, 0, 0, 110, 0.05, 0)`,
      )
      insert.run("e1", t, "s1", "mystery-provider", "mystery-model")
      db.close()
      const report = reportFor(dbPath, { kind: "all" })
      assert.equal(report.cost.unknown, true)
      assert.equal(report.cost.total, null)
      // exact cost from opencode is still reported
      assert.equal(report.cost.exact, 0.05)
    } finally {
      rmrf(dir)
    }
  })

  it("computes averages and largest request", () => {
    const dbPath = setup()
    const report = reportFor(dbPath, { kind: "all" })
    // gross input across all three events: 6200 + 10100 + 500
    assert.equal(report.averages.inputTokensPerUserMessage, 16800)
    assert.equal(report.largestRequest?.totalTokens, 10400)
    assert.equal(report.topModels.mostUsed?.model, "claude-sonnet-4-6")
    assert.equal(report.topModels.mostExpensive?.model, "claude-sonnet-4-6")
    rmrf(path.dirname(dbPath))
  })

  it("applies model/provider filters", () => {
    const dbPath = setup()
    const model = reportFor(dbPath, { kind: "all" })
    const filtered = reportFor(dbPath, { kind: "all" })
    void filtered
    void model
    const db = UsageDatabase.open(dbPath, { readOnly: true })
    const byModel = computeReport(db, { kind: "all" }, { model: "gpt-4o" }, { pricing: new HybridPricingProvider(db) })
    assert.equal(byModel.counts.modelRequests, 1)
    assert.equal(byModel.perModel[0]!.provider, "openai")
    db.close()
    rmrf(path.dirname(dbPath))
  })
})

describe("period helpers + formatters", () => {
  it("periodRange computes boundaries", () => {
    const now = Date.now()
    const today = periodRange({ kind: "today" }, now)
    const d = new Date(now)
    assert.equal(today.start, new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime())
    assert.equal(periodRange({ kind: "week" }, now).start, now - 7 * 24 * 3600_000)
    assert.equal(periodRange({ kind: "month" }, now).start, now - 30 * 24 * 3600_000)
    assert.deepEqual(periodRange({ kind: "all" }, now), { start: null, end: null })
  })

  it("periodLabel renders human labels", () => {
    assert.equal(periodLabel({ kind: "session", sessionId: "x" }), "Current Session")
    assert.equal(periodLabel({ kind: "today" }), "Today")
    assert.equal(periodLabel({ kind: "week" }), "Last 7 Days")
    assert.equal(periodLabel({ kind: "month" }), "Last 30 Days")
    assert.equal(periodLabel({ kind: "all" }), "All Time")
  })

  it("token/cost formatting", () => {
    assert.equal(formatTokens(1_500_000), "1.50M")
    assert.equal(formatTokens(2_500), "2.5K")
    assert.equal(formatCost(0.00981), "$0.0098")
    assert.equal(formatCost(0.51), "$0.51")
    assert.equal(formatCost(null), "Unknown")
    assert.equal(formatCost(0), "$0.00")
  })

  it("markdown report renders without errors for empty db", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const db = UsageDatabase.open(dbPath)
      const report = computeReport(db, { kind: "all" }, {}, { pricing: new HybridPricingProvider(db) })
      const markdown = renderReportMarkdown(report)
      assert.ok(markdown.includes("OPENCODE USAGE"))
      assert.ok(markdown.includes("Cache data: Not available"))
      assert.ok(markdown.includes("ESTIMATED"))
      db.close()
    } finally {
      rmrf(dir)
    }
  })
})
