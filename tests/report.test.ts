import { describe, it } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { tmpDir, rmrf, seedUsageEvents } from "./helpers.ts"
import { UsageDatabase } from "../src/storage/database.ts"
import { buildComparison, computeReport, periodRange, periodLabel, type PeriodComparison } from "../src/reporting/usage-report.ts"
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

describe("buildComparison", () => {
  // Fixed clock: Wed Jul 15 2026, 12:00 local. Windows are fully deterministic:
  //   month: current [Jun 15 12:00, open), previous [May 16 12:00, Jun 15 12:00)
  //   week:  current [Jul 08 12:00, open), previous [Jul 01 12:00, Jul 08 12:00)
  //   today: current [Jul 15 00:00, open), previous [Jul 14 12:00, Jul 15 00:00)
  const NOW = new Date(2026, 6, 15, 12, 0, 0, 0).getTime()
  const DAY_MS = 24 * 3600_000

  function seed(dbPath: string, events: Array<{ key: string; ts: number; tokens?: number; cost?: number | null }>): void {
    const db = UsageDatabase.open(dbPath)
    const insert = db.raw.prepare(
      `INSERT INTO usage_events (
         event_key, timestamp, session_id, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_tokens, cost, provider_reported_cache
       ) VALUES (?, ?, 'ses_cmp', 'anthropic', 'claude-sonnet-4-6', ?, 0, 0, 0, ?, ?, 0)`,
    )
    for (const e of events) {
      const tokens = e.tokens ?? 100
      insert.run(e.key, e.ts, tokens / 2, tokens, e.cost === undefined ? 0.01 : e.cost)
    }
    db.close()
  }

  function comparisonFor(dbPath: string, period: Parameters<typeof buildComparison>[1]): PeriodComparison {
    const db = UsageDatabase.open(dbPath, { readOnly: true })
    try {
      return buildComparison(db, period, {}, { pricing: new HybridPricingProvider(db), now: NOW })
    } finally {
      db.close()
    }
  }

  it("splits month windows at the exact boundary across a calendar-month edge", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seed(dbPath, [
        { key: "p1-prev-start-edge", ts: NOW - 60 * DAY_MS }, // exactly May 16 12:00 -> previous only
        { key: "p2-jun1", ts: new Date(2026, 5, 1, 9, 0).getTime() },
        { key: "p3-jun10", ts: new Date(2026, 5, 10, 10, 30).getTime() },
        { key: "p4-before-boundary", ts: NOW - 30 * DAY_MS - 3600_000 }, // Jun 15 11:00 -> previous
        { key: "b-boundary", ts: NOW - 30 * DAY_MS }, // exactly Jun 15 12:00 -> CURRENT only, never previous
        { key: "c-jul1", ts: new Date(2026, 6, 1, 8, 0).getTime() },
        { key: "c-now", ts: NOW },
      ])
      // default tokens=100/cost=0.01 each: current 3x100, previous 4x100
      const cmp = comparisonFor(dbPath, { kind: "month" })
      assert.equal(cmp.available, true)
      assert.equal(cmp.label, "Last 30 Days")
      assert.deepEqual(cmp.current, { requests: 3, totalTokens: 300, cost: 0.03 })
      assert.deepEqual(cmp.previous, { requests: 4, totalTokens: 400, cost: 0.04 })
      assert.equal(cmp.delta.requestsPct, -25)
      assert.equal(cmp.delta.totalTokensPct, -25)
      assert.equal(cmp.delta.costPct, -25)
    } finally {
      rmrf(dir)
    }
  })

  it("week compares the identical 7-day window immediately before", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seed(dbPath, [
        // inside the previous week window [Jul 01 12:00, Jul 08 12:00)
        { key: "prev-week", ts: new Date(2026, 6, 3, 9, 0).getTime(), tokens: 500, cost: 0.05 },
        // Jul 01 08:00 is BEFORE the previous window starts -> in neither week window
        { key: "before-prev-week", ts: new Date(2026, 6, 1, 8, 0).getTime() },
        // current week
        { key: "cur-week", ts: NOW - 2 * DAY_MS, tokens: 250, cost: 0.02 },
        { key: "cur-now", ts: NOW },
      ])
      const cmp = comparisonFor(dbPath, { kind: "week" })
      assert.equal(cmp.available, true)
      assert.equal(cmp.label, "Last 7 Days")
      assert.equal(cmp.current.requests, 2)
      assert.equal(cmp.current.totalTokens, 350)
      assert.equal(cmp.previous.requests, 1)
      assert.equal(cmp.previous.totalTokens, 500)
      assert.equal(cmp.delta.totalTokensPct, -30)
    } finally {
      rmrf(dir)
    }
  })

  it("today compares the same elapsed length before midnight", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seed(dbPath, [
        // yesterday 18:00 is inside [Jul 14 12:00, Jul 15 00:00)
        { key: "yesterday-evening", ts: new Date(2026, 6, 14, 18, 0).getTime(), tokens: 400, cost: 0.04 },
        // yesterday morning falls outside that window
        { key: "yesterday-morning", ts: new Date(2026, 6, 14, 8, 0).getTime() },
        { key: "today-now", ts: NOW, tokens: 100, cost: 0.01 },
      ])
      const cmp = comparisonFor(dbPath, { kind: "today" })
      assert.equal(cmp.available, true)
      assert.deepEqual(cmp.current, { requests: 1, totalTokens: 100, cost: 0.01 })
      assert.deepEqual(cmp.previous, { requests: 1, totalTokens: 400, cost: 0.04 })
      assert.equal(cmp.delta.requestsPct, 0)
      assert.equal(cmp.delta.totalTokensPct, -75)
      assert.equal(cmp.delta.costPct, -75)
    } finally {
      rmrf(dir)
    }
  })

  it("is unavailable with zeroed fields for session and all periods", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seed(dbPath, [{ key: "e1", ts: NOW }])
      for (const period of [{ kind: "session", sessionId: "ses_cmp" }, { kind: "all" }] as const) {
        const cmp = comparisonFor(dbPath, period)
        assert.equal(cmp.available, false)
        assert.deepEqual(cmp.current, { requests: 0, totalTokens: 0, cost: 0 })
        assert.deepEqual(cmp.previous, { requests: 0, totalTokens: 0, cost: 0 })
        assert.deepEqual(cmp.delta, { requestsPct: null, totalTokensPct: null, costPct: null })
      }
    } finally {
      rmrf(dir)
    }
  })

  it("delta null rules: both empty, brand-new usage, and decline-to-zero", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      // no events at all -> both windows empty -> every pct null
      seed(dbPath, [])
      const empty = comparisonFor(dbPath, { kind: "today" })
      assert.equal(empty.available, true)
      assert.deepEqual(empty.delta, { requestsPct: null, totalTokensPct: null, costPct: null })

      // events only in the current window -> prev == 0 && cur > 0 -> still null ('new' in UI)
      seed(dbPath, [{ key: "only-now", ts: NOW, tokens: 300, cost: 0.03 }])
      const fresh = comparisonFor(dbPath, { kind: "today" })
      assert.equal(fresh.delta.requestsPct, null)
      assert.equal(fresh.delta.totalTokensPct, null)

      // events only in the previous window -> decline to zero is a real number (-100)
      const older = path.join(dir, "older.db")
      seed(older, [{ key: "only-prev", ts: NOW - 60 * DAY_MS, tokens: 300 }])
      const declined = comparisonFor(older, { kind: "month" })
      assert.equal(declined.current.requests, 0)
      assert.equal(declined.delta.requestsPct, -100)
      assert.equal(declined.delta.totalTokensPct, -100)
    } finally {
      rmrf(dir)
    }
  })

  it("rounds pcts to integers and nulls cost when either side has unknown costs", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seed(dbPath, [
        { key: "prev", ts: NOW - 60 * DAY_MS + 3600_000, tokens: 300, cost: 0.02 },
        { key: "cur-rounding", ts: NOW - 29 * DAY_MS, tokens: 400, cost: null },
      ])
      const cmp = comparisonFor(dbPath, { kind: "month" })
      // (400-300)/300*100 = 33.33 -> 33
      assert.equal(cmp.delta.totalTokensPct, 33)
      assert.equal(cmp.delta.requestsPct, 0)
      // any unknown-cost event makes its whole window's cost unknown -> not comparable
      assert.equal(cmp.current.cost, null)
      assert.equal(cmp.previous.cost, 0.02)
      assert.equal(cmp.delta.costPct, null)
    } finally {
      rmrf(dir)
    }
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
