/**
 * Tests for the usage timeline (Graph view data) and its view model.
 *
 * Dates are pinned to local 2026-06-15 (a Monday) so bucket labels, counts
 * and boundaries are fully deterministic no matter when the suite runs.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { tmpDir, rmrf } from "./helpers.ts"
import { UsageDatabase } from "../src/storage/database.ts"
import {
  computeUsageTimeline,
  timelineGranularity,
  type TimelineBucket,
} from "../src/reporting/usage-report.ts"
import { HybridPricingProvider } from "../src/pricing/modelsdev.ts"
import { buildUsageTimelineModel, TIMELINE_BAR_WIDTH } from "../src/ui/usage/usage-view-model.ts"
import type { ReportPeriod } from "../src/types/usage.ts"

const NOW = new Date(2026, 5, 15, 14, 20, 0, 0).getTime() // Mon Jun 15 2026, 14:20 local
const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

interface SeedEvent {
  key: string
  ts: number
  session?: string
  provider?: string
  model?: string
  input?: number
  output?: number
  cost?: number | null
}

function seedEvents(dbPath: string, events: SeedEvent[]): void {
  const db = UsageDatabase.open(dbPath)
  const insert = db.raw.prepare(
    `INSERT INTO usage_events (
       event_key, timestamp, session_id, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       total_tokens, cost, provider_reported_cache
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0)`,
  )
  for (const e of events) {
    const input = e.input ?? 1000
    const output = e.output ?? 100
    insert.run(e.key, e.ts, e.session ?? "ses_x", e.provider ?? "anthropic", e.model ?? "claude-sonnet-4-6", input, output, input + output, e.cost === undefined ? 0.01 : e.cost)
  }
  db.close()
}

function timelineFor(dbPath: string, period: ReportPeriod): TimelineBucket[] {
  const db = UsageDatabase.open(dbPath, { readOnly: true })
  try {
    return computeUsageTimeline(db, period, {}, { pricing: new HybridPricingProvider(db), now: NOW })
  } finally {
    db.close()
  }
}

/** The single bucket whose [start, end) window contains ts. */
function bucketContaining(buckets: TimelineBucket[], ts: number): TimelineBucket {
  const bucket = buckets.find((b) => ts >= b.start && ts < b.end)
  assert.ok(bucket, `no bucket contains timestamp ${ts}`)
  return bucket
}

const sumTokens = (buckets: TimelineBucket[]) => buckets.reduce((sum, b) => sum + b.totalTokens, 0)

describe("computeUsageTimeline", () => {
  it("buckets 'today' hourly and 'month' daily", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seedEvents(dbPath, [
        { key: "t1", ts: new Date(2026, 5, 15, 0, 5).getTime(), input: 500, output: 50 },
        { key: "t2", ts: new Date(2026, 5, 15, 2, 10).getTime(), input: 700, output: 70 },
        { key: "old", ts: new Date(2026, 5, 5, 9, 30).getTime(), input: 900, output: 90 },
      ])

      assert.equal(timelineGranularity({ kind: "today" }), "hourly")
      assert.equal(timelineGranularity({ kind: "month" }), "daily")

      const today = timelineFor(dbPath, { kind: "today" })
      // hours 00:00 through the current hour 14:00 — empty ones included
      assert.equal(today.length, 15)
      assert.equal(today[0]!.label, "00:00")
      assert.equal(today[14]!.label, "14:00")
      for (const bucket of today) assert.match(bucket.label, /^\d{2}:00$/)
      assert.equal(sumTokens(today), 500 + 50 + 700 + 70)
      assert.equal(bucketContaining(today, new Date(2026, 5, 15, 0, 5).getTime()).totalTokens, 550)
      assert.equal(bucketContaining(today, new Date(2026, 5, 15, 2, 10).getTime()).totalTokens, 770)

      const month = timelineFor(dbPath, { kind: "month" })
      // May 16 .. Jun 15 inclusive — one bucket per day, empties included
      assert.equal(month.length, 31)
      assert.equal(month[0]!.start, new Date(2026, 4, 16).getTime())
      assert.equal(month[0]!.label, "Sat 16")
      assert.equal(month[30]!.label, "Mon 15")
      for (const bucket of month) assert.match(bucket.label, /^[A-Z][a-z]{2} \d{1,2}$/)
      assert.equal(sumTokens(month), 2310)
      assert.equal(bucketContaining(month, new Date(2026, 5, 5, 9, 30).getTime()).totalTokens, 990)
    } finally {
      rmrf(dir)
    }
  })

  it("orders buckets chronologically and keeps empty ones", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const eventTs = new Date(2026, 5, 10, 11, 45).getTime()
      seedEvents(dbPath, [{ key: "only", ts: eventTs, input: 400, output: 40 }])

      const month = timelineFor(dbPath, { kind: "month" })
      assert.equal(month.length, 31)
      for (let i = 1; i < month.length; i++) {
        assert.ok(month[i]!.start > month[i - 1]!.start, `bucket ${i} out of order`)
        assert.ok(month[i]!.end > month[i]!.start, `bucket ${i} has empty range`)
      }
      const nonEmpty = month.filter((b) => b.totalTokens > 0)
      assert.equal(nonEmpty.length, 1)
      assert.equal(nonEmpty[0]!.start, new Date(2026, 5, 10).getTime())
      assert.equal(nonEmpty[0]!.inputTokens, 400)
      assert.equal(nonEmpty[0]!.outputTokens, 40)
      // every other bucket is a real zero bucket, not missing
      assert.equal(month.filter((b) => b.totalTokens === 0).length, 30)
      assert.equal(sumTokens(month), 440)
    } finally {
      rmrf(dir)
    }
  })

  it("falls back to the recorded at-use cost when pricing is unknown, without leaking into others", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const knownTs = new Date(2026, 5, 12, 10, 0).getTime()
      const mysteryTs = new Date(2026, 5, 10, 8, 0).getTime()
      seedEvents(dbPath, [
        { key: "known", ts: knownTs },
        { key: "mystery", ts: mysteryTs, provider: "mystery-provider", model: "mystery-model" },
        { key: "known-same-day", ts: mysteryTs + HOUR_MS }, // same bucket as the mystery event
      ])

      const month = timelineFor(dbPath, { kind: "month" })
      const knownBucket = bucketContaining(month, knownTs)
      const mixedBucket = bucketContaining(month, mysteryTs)
      assert.equal(typeof knownBucket.cost, "number")
      assert.ok(knownBucket.cost! > 0)
      // unknown-pricing events contribute their recorded at-use cost (0.01)…
      assert.equal(typeof mixedBucket.cost, "number")
      assert.ok(mixedBucket.cost! > 0)
      // …tokens still count, and neighbors stay unaffected
      assert.equal(mixedBucket.totalTokens, 1100 + 1100)
      assert.equal(knownBucket.totalTokens, 1100)
    } finally {
      rmrf(dir)
    }
  })

  it("bucket cost is null only when an event has neither pricing nor a recorded cost", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const mysteryTs = new Date(2026, 5, 10, 8, 0).getTime()
      seedEvents(dbPath, [
        { key: "mystery-no-cost", ts: mysteryTs, provider: "mystery-provider", model: "mystery-model", cost: null },
      ])

      const month = timelineFor(dbPath, { kind: "month" })
      const bucket = bucketContaining(month, mysteryTs)
      assert.equal(bucket.cost, null)
      assert.equal(bucket.totalTokens, 1100)
    } finally {
      rmrf(dir)
    }
  })

  it("'all' caps to the 30 most recent daily buckets and drops older events", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seedEvents(dbPath, [
        { key: "ancient", ts: new Date(2026, 4, 6, 12, 0).getTime(), input: 9999, output: 999 }, // May 6 — outside the cap
        { key: "recent", ts: NOW - 2 * HOUR_MS, input: 300, output: 30 },
      ])

      const all = timelineFor(dbPath, { kind: "all" })
      assert.equal(all.length, 30)
      assert.equal(all[0]!.start, new Date(2026, 4, 17).getTime())
      assert.equal(all[29]!.label, "Mon 15")
      for (let i = 1; i < all.length; i++) {
        assert.ok(all[i]!.start > all[i - 1]!.start)
      }
      assert.equal(sumTokens(all), 330)
    } finally {
      rmrf(dir)
    }
  })

  it("maxBuckets: null lifts the 'all' display cap (data exports need full history)", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      // one event per day for 40 days, ending today
      seedEvents(
        dbPath,
        Array.from({ length: 40 }, (_, i) => ({
          key: `d${i}`,
          ts: new Date(2026, 4, 7 + i, 12, 0).getTime(), // May 7 .. Jun 15
        })),
      )

      // default keeps the TUI's 30-bucket cap …
      assert.equal(timelineFor(dbPath, { kind: "all" }).length, 30)

      // … while maxBuckets: null spans every day back to the first event
      const db = UsageDatabase.open(dbPath, { readOnly: true })
      try {
        const unbounded = computeUsageTimeline(db, { kind: "all" }, {}, { pricing: new HybridPricingProvider(db), now: NOW, maxBuckets: null })
        assert.equal(unbounded.length, 40)
        assert.equal(unbounded[0]!.start, new Date(2026, 4, 7).getTime())
        assert.equal(unbounded[39]!.label, "Mon 15")
        assert.equal(unbounded.filter((b) => b.totalTokens > 0).length, 40)
        assert.equal(sumTokens(unbounded), 40 * 1100)
      } finally {
        db.close()
      }
    } finally {
      rmrf(dir)
    }
  })

  it("buckets the current session hourly across its own span", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seedEvents(dbPath, [
        { key: "s1", ts: new Date(2026, 5, 15, 9, 0).getTime(), session: "ses_g" },
        { key: "s2", ts: new Date(2026, 5, 15, 12, 30).getTime(), session: "ses_g" },
        { key: "other", ts: new Date(2026, 5, 15, 10, 0).getTime(), session: "ses_other" },
      ])

      const session = timelineFor(dbPath, { kind: "session", sessionId: "ses_g" })
      assert.equal(session.length, 4) // 09:00 .. 12:00
      assert.equal(session[0]!.label, "09:00")
      assert.equal(session[3]!.label, "12:00")
      assert.equal(session.filter((b) => b.totalTokens === 0).length, 2)
      assert.equal(sumTokens(session), 2200)
    } finally {
      rmrf(dir)
    }
  })
})

describe("buildUsageTimelineModel", () => {
  function bucket(totalTokens: number, cost: number | null = 0.5): TimelineBucket {
    return { label: "Mon 15", start: 0, end: DAY_MS, inputTokens: totalTokens, outputTokens: 0, totalTokens, cost }
  }

  function hourlyBucket(index: number, totalTokens: number, cost: number | null = 0.5): TimelineBucket {
    // Anchor to local midnight so day-grouping is timezone-safe.
    const now = new Date()
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const start = dayStart + index * 3600_000
    const d = new Date(start)
    return {
      label: `${String(d.getHours()).padStart(2, "0")}:00`,
      start,
      end: start + 3600_000,
      inputTokens: totalTokens,
      outputTokens: 0,
      totalTokens,
      cost,
    }
  }

  it("scales bars to the max bucket and leaves interior zero buckets empty", () => {
    const { rows } = buildUsageTimelineModel([bucket(800, 0.02), bucket(0, 0), bucket(400, 0.01)])
    assert.equal(rows.length, 3)
    assert.equal(rows[0]!.bar, "█".repeat(TIMELINE_BAR_WIDTH)) // max bucket -> full width
    assert.equal(rows[1]!.bar, "") // interior zero bucket -> empty bar (real gap)
    assert.equal(rows[2]!.bar, "█".repeat(TIMELINE_BAR_WIDTH / 2))
  })

  it("trims empty leading/trailing buckets so the axis hugs the data", () => {
    const { rows } = buildUsageTimelineModel([bucket(0, 0), bucket(0, 0), bucket(800, 0.02), bucket(400, 0.01), bucket(0, 0)])
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.tokensText, "800")
    assert.equal(rows[1]!.tokensText, "400")
  })

  it("folds long hourly axes into daily buckets", () => {
    // 30 non-empty hourly buckets across two days -> two daily rows
    const buckets = Array.from({ length: 30 }, (_, i) => hourlyBucket(i, 100))
    const { rows, foldedToDaily } = buildUsageTimelineModel(buckets)
    assert.equal(foldedToDaily, true)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.tokensText), ["2.4K", "600"])
  })

  it("does not fold short axes", () => {
    const buckets = Array.from({ length: 5 }, (_, i) => hourlyBucket(i, 100))
    const { rows, foldedToDaily } = buildUsageTimelineModel(buckets)
    assert.equal(foldedToDaily, false)
    assert.equal(rows.length, 5)
    assert.match(rows[0]!.label, /^\d{2}:00$/)
  })

  it("keeps at least one bar character for any positive bucket", () => {
    const { rows } = buildUsageTimelineModel([bucket(1_000_000, 1), bucket(1, 0.001)])
    assert.equal(rows[0]!.bar.length, TIMELINE_BAR_WIDTH)
    assert.ok(rows[1]!.bar.length >= 1)
    assert.equal(rows[1]!.bar.length, 1)
  })

  it("formats tokens and costs with the shared helpers, em dash for null cost", () => {
    const { rows, costKnown } = buildUsageTimelineModel([bucket(1500, 0.03), bucket(200, null)])
    assert.equal(costKnown, true)
    assert.equal(rows[0]!.tokensText, "1.5K")
    assert.equal(rows[0]!.costText, "$0.03")
    assert.equal(rows[0]!.cost, 0.03)
    assert.equal(rows[1]!.tokensText, "200")
    assert.equal(rows[1]!.costText, "—")
    assert.equal(rows[1]!.cost, null)
  })

  it("reports costKnown=false when no bucket has pricing", () => {
    const { rows, costKnown } = buildUsageTimelineModel([bucket(100, null), bucket(200, null)])
    assert.equal(costKnown, false)
    assert.ok(rows.every((row) => row.costText === "—"))
  })

  it("maps no buckets to no rows", () => {
    assert.deepEqual(buildUsageTimelineModel([]), { rows: [], costKnown: false, foldedToDaily: false })
  })

  it("cost mode scales bars by bucket cost, max-cost bucket full width", () => {
    // cost order is the inverse of token order, proving bars track cost
    const { rows } = buildUsageTimelineModel([bucket(400, 2), bucket(0, 0), bucket(800, 1)], { metric: "cost" })
    assert.equal(rows.length, 3) // interior zero-cost bucket stays (real gap)
    assert.equal(rows[0]!.bar, "█".repeat(TIMELINE_BAR_WIDTH)) // max-cost bucket -> full width
    assert.equal(rows[1]!.bar, "") // zero-cost bucket -> empty bar
    assert.equal(rows[2]!.bar, "█".repeat(TIMELINE_BAR_WIDTH / 2))
    // the token column is untouched by the mode switch
    assert.equal(rows[0]!.tokensText, "400")
  })

  it("cost mode excludes unknown-cost buckets from the scale and renders '?'", () => {
    const { rows } = buildUsageTimelineModel([bucket(900, null), bucket(200, 4), bucket(50, 1)], { metric: "cost" })
    assert.equal(rows[0]!.bar, "")
    assert.equal(rows[0]!.costText, "?") // never "$0.00" or "—"
    assert.equal(rows[0]!.tokensText, "900")
    // known costs scale among themselves (max = 4), as if the null bucket were absent
    assert.equal(rows[1]!.bar, "█".repeat(TIMELINE_BAR_WIDTH))
    assert.equal(rows[2]!.bar, "█".repeat(TIMELINE_BAR_WIDTH / 4))
  })

  it("cost mode renders every bar empty with '?' when no bucket has pricing", () => {
    const { rows, costKnown } = buildUsageTimelineModel([bucket(100, null), bucket(200, null)], { metric: "cost" })
    assert.equal(costKnown, false)
    for (const row of rows) {
      assert.equal(row.bar, "")
      assert.equal(row.costText, "?")
    }
  })

  it("defaults to token scaling regardless of cost values", () => {
    const buckets = [bucket(400, 9), bucket(800, 0.01)]
    assert.deepEqual(buildUsageTimelineModel(buckets), buildUsageTimelineModel(buckets, { metric: "tokens" }))
    const { rows } = buildUsageTimelineModel(buckets)
    assert.equal(rows[0]!.bar, "█".repeat(TIMELINE_BAR_WIDTH / 2)) // scaled by tokens, not the $9 cost
    assert.equal(rows[1]!.bar, "█".repeat(TIMELINE_BAR_WIDTH))
    assert.equal(rows[0]!.costText, "$9.00")
  })
})
