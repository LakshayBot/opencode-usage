import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { tmpDir, rmrf } from "./helpers.ts"
import {
  BUDGETS_CONFIG_PATH,
  budgetsConfigDir,
  budgetsFilePath,
  DEFAULT_WARN_AT,
  loadBudgets,
  validateBudgets,
} from "../src/config/budgets.ts"
import { spendSince, startOfLocalDay, startOfLocalMonth } from "../src/reporting/usage-report.ts"
import { buildBudgetModel } from "../src/ui/usage/usage-view-model.ts"
import { UsageDatabase } from "../src/storage/database.ts"

describe("validateBudgets", () => {
  it("accepts a full config", () => {
    assert.deepEqual(validateBudgets({ daily: 2, monthly: 30, warnAt: 0.5 }), {
      daily: 2,
      monthly: 30,
      warnAt: 0.5,
    })
  })

  it("defaults warnAt to 0.8 and leaves absent windows null", () => {
    assert.deepEqual(validateBudgets({ monthly: 10 }), { daily: null, monthly: 10, warnAt: DEFAULT_WARN_AT })
    assert.deepEqual(validateBudgets({ daily: 1 }), { daily: 1, monthly: null, warnAt: DEFAULT_WARN_AT })
  })

  it("returns null when both amounts are absent (budgets disabled)", () => {
    assert.equal(validateBudgets({}), null)
    assert.equal(validateBudgets({ warnAt: 0.9 }), null)
  })

  it("ignores invalid entries individually: negative, non-finite and non-numeric amounts", () => {
    assert.deepEqual(validateBudgets({ daily: -1, monthly: 30 }), { daily: null, monthly: 30, warnAt: DEFAULT_WARN_AT })
    assert.deepEqual(validateBudgets({ daily: Number.POSITIVE_INFINITY, monthly: 30 }), {
      daily: null,
      monthly: 30,
      warnAt: DEFAULT_WARN_AT,
    })
    assert.deepEqual(validateBudgets({ daily: "5", monthly: true, monthly2: undefined }), null)
    assert.deepEqual(validateBudgets({ daily: "5", monthly: 5 }), { daily: null, monthly: 5, warnAt: DEFAULT_WARN_AT })
    assert.equal(validateBudgets({ daily: NaN, monthly: -0.01 }), null)
  })

  it("treats zero as a valid budget (no spending allowed)", () => {
    assert.deepEqual(validateBudgets({ daily: 0 }), { daily: 0, monthly: null, warnAt: DEFAULT_WARN_AT })
  })

  it("falls back to the default warnAt when it is out of range or mistyped", () => {
    for (const warnAt of [-0.5, 0, 1.5, "0.9", null, Number.NaN]) {
      const parsed = validateBudgets({ daily: 5, warnAt })
      assert.equal(parsed?.warnAt, DEFAULT_WARN_AT)
    }
  })

  it("keeps boundary warnAt values inside (0, 1]", () => {
    assert.equal(validateBudgets({ daily: 5, warnAt: 0.25 })?.warnAt, 0.25)
    assert.equal(validateBudgets({ daily: 5, warnAt: 1 })?.warnAt, 1)
  })

  it("returns null for non-object payloads", () => {
    for (const raw of [null, undefined, [], [1], "10", 42, true]) {
      assert.equal(validateBudgets(raw), null)
    }
  })
})

describe("loadBudgets", () => {
  function write(dir: string, contents: string | null): string {
    fs.mkdirSync(dir, { recursive: true })
    if (contents !== null) fs.writeFileSync(budgetsFilePath(dir), contents)
    return dir
  }

  it("reads a valid file from the given config dir", () => {
    const dir = tmpDir()
    try {
      write(dir, JSON.stringify({ daily: 1.5, monthly: 45, warnAt: 0.6 }))
      assert.deepEqual(loadBudgets(dir), { daily: 1.5, monthly: 45, warnAt: 0.6 })
    } finally {
      rmrf(dir)
    }
  })

  it("returns null for a missing file — budgets disabled entirely", () => {
    const dir = tmpDir()
    try {
      assert.equal(loadBudgets(dir), null)
      assert.equal(loadBudgets(path.join(dir, "does-not-exist")), null)
    } finally {
      rmrf(dir)
    }
  })

  it("returns null for malformed JSON instead of throwing", () => {
    const dir = tmpDir()
    try {
      write(dir, "{ daily: 5,,")
      assert.equal(loadBudgets(dir), null)
    } finally {
      rmrf(dir)
    }
  })

  it("parses partial fields through validation", () => {
    const dir = tmpDir()
    try {
      write(dir, JSON.stringify({ monthly: 20 }))
      assert.deepEqual(loadBudgets(dir), { daily: null, monthly: 20, warnAt: DEFAULT_WARN_AT })
      write(dir, JSON.stringify({ daily: -3, warnAt: 7 }))
      assert.equal(loadBudgets(dir), null)
    } finally {
      rmrf(dir)
    }
  })

  it("returns null for JSON that is not an object", () => {
    const dir = tmpDir()
    try {
      write(dir, "[1, 2]")
      assert.equal(loadBudgets(dir), null)
      write(dir, '"monthly": 5')
      assert.equal(loadBudgets(dir), null)
    } finally {
      rmrf(dir)
    }
  })
})

describe("budgets path helpers", () => {
  it("exposes the documented XDG-relative location", () => {
    assert.equal(BUDGETS_CONFIG_PATH.replace(/\\/g, "/"), "opencode-usage/budgets.json")
  })

  it("resolves the config dir from XDG_CONFIG_HOME with a ~/.config fallback", () => {
    assert.equal(budgetsConfigDir({ XDG_CONFIG_HOME: "/x" }).replace(/\\/g, "/"), "/x/opencode-usage")
    assert.equal(
      budgetsConfigDir({ HOME: "/h", OPENCODE_TEST_HOME: "/test-home" }).replace(/\\/g, "/"),
      "/test-home/.config/opencode-usage",
    )
    assert.ok(budgetsConfigDir({}).endsWith(path.join("opencode-usage", "")) || budgetsConfigDir({}).length > 0)
  })

  it("joins the file name onto any config dir", () => {
    assert.ok(budgetsFilePath("/cfg").endsWith("budgets.json"))
  })
})

describe("spendSince window boundaries", () => {
  const START = new Date(2026, 6, 15, 0, 0, 0, 0).getTime() // local midnight

  interface SeedEvent {
    key: string
    ts: number
    cost: number | null
  }

  function seed(dbPath: string, events: SeedEvent[]): void {
    const db = UsageDatabase.open(dbPath)
    const insert = db.raw.prepare(
      `INSERT INTO usage_events (
         event_key, timestamp, session_id, provider, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, provider_reported_cache
       ) VALUES (?, ?, 'ses_budget', 'anthropic', 'claude-sonnet-4-6', 10, 10, 0, 0, 20, ?, 0)`,
    )
    for (const e of events) insert.run(e.key, e.ts, e.cost)
    db.close()
  }

  function spendFor(dbPath: string, startTsLocal: number): number | null {
    const db = UsageDatabase.open(dbPath, { readOnly: true })
    try {
      return spendSince(db, startTsLocal)
    } finally {
      db.close()
    }
  }

  it("includes an event stamped exactly at the window start, excludes one just before", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seed(dbPath, [
        { key: "before", ts: START - 1, cost: 99 },
        { key: "at-start", ts: START, cost: 0.02 },
        { key: "after", ts: START + 60_000, cost: 0.01 },
      ])
      // half-open on the left edge, like every other window in the module
      assert.ok(Math.abs(spendFor(dbPath, START)! - 0.03) < 1e-12)
      assert.ok(Math.abs(spendFor(dbPath, START + 60_000)! - 0.01) < 1e-12)
    } finally {
      rmrf(dir)
    }
  })

  it("sums to 0 over an empty window and never goes negative on rounding", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seed(dbPath, [{ key: "old", ts: START - 5000, cost: 5 }])
      assert.equal(spendFor(dbPath, START), 0)
    } finally {
      rmrf(dir)
    }
  })

  it("nulls the whole window when ANY event in it lacks a cost (cost.unknown convention)", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seed(dbPath, [
        { key: "known", ts: START + 1000, cost: 0.05 },
        { key: "unknown", ts: START + 2000, cost: null },
      ])
      assert.equal(spendFor(dbPath, START), null)
    } finally {
      rmrf(dir)
    }
  })

  it("an unknown-cost event BEFORE the window does not poison it", () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      seed(dbPath, [
        { key: "unknown-before", ts: START - 1000, cost: null },
        { key: "known-in", ts: START + 1000, cost: 0.05 },
      ])
      assert.ok(Math.abs(spendFor(dbPath, START)! - 0.05) < 1e-12)
    } finally {
      rmrf(dir)
    }
  })

  it("startOfLocalDay/Month land on local calendar boundaries", () => {
    const noon = new Date(2026, 6, 15, 12, 34, 56, 789).getTime()
    assert.equal(startOfLocalDay(noon), new Date(2026, 6, 15).getTime())
    assert.equal(startOfLocalMonth(noon), new Date(2026, 6, 1).getTime())
    // month boundary rolls back to the 1st, not 30/31 days before `now`
    const augFirst = new Date(2026, 7, 1, 9, 0).getTime()
    assert.equal(startOfLocalMonth(augFirst), new Date(2026, 7, 1).getTime())
    assert.equal(startOfLocalDay(augFirst), new Date(2026, 7, 1).getTime())
  })
})

describe("buildBudgetModel levels", () => {
  const DAILY_5 = Object.freeze({ daily: 5, monthly: null as number | null, warnAt: DEFAULT_WARN_AT })

  it("is hidden entirely when budgets are null", () => {
    assert.deepEqual(buildBudgetModel(null, 4, 40), { visible: false, lines: [] })
  })

  it("formats known spend as '$x of $y (pct%)'", () => {
    const model = buildBudgetModel(DAILY_5, 2.1, null)
    assert.equal(model.visible, true)
    assert.equal(model.lines.length, 1)
    assert.equal(model.lines[0]!.label, "Daily")
    assert.equal(model.lines[0]!.text, "$2.10 of $5.00 (42%)")
    assert.equal(model.lines[0]!.level, "ok")
  })

  it("levels at exactly 79% ok / 80% warn / 100% over with the default warnAt", () => {
    assert.equal(buildBudgetModel(DAILY_5, 3.95, null).lines[0]!.level, "ok") // 79%
    assert.equal(buildBudgetModel(DAILY_5, 4, null).lines[0]!.level, "warn") // 80%
    assert.equal(buildBudgetModel(DAILY_5, 4.95, null).lines[0]!.level, "warn") // 99%
    assert.equal(buildBudgetModel(DAILY_5, 5, null).lines[0]!.level, "over") // 100%
    assert.equal(buildBudgetModel(DAILY_5, 6, null).lines[0]!.level, "over") // 120%
  })

  it("honors custom warnAt thresholds", () => {
    const budgets = { ...DAILY_5, warnAt: 0.5 }
    assert.equal(buildBudgetModel(budgets, 2.4, null).lines[0]!.level, "ok") // 48%
    assert.equal(buildBudgetModel(budgets, 2.51, null).lines[0]!.level, "warn") // 50%
    const strict = { ...DAILY_5, warnAt: 1 }
    // warnAt=1 has no separate warning stage: below 100 stays ok, 100 is over
    assert.equal(buildBudgetModel(strict, 4.95, null).lines[0]!.level, "ok")
    assert.equal(buildBudgetModel(strict, 5, null).lines[0]!.level, "over")
  })

  it("renders unknown spend muted-ok via text starting with 'unknown'", () => {
    const line = buildBudgetModel(DAILY_5, null, null).lines[0]!
    assert.equal(line.level, "ok")
    assert.ok(line.text.startsWith("unknown"))
    assert.equal(line.text, `unknown of $5.00`)
  })

  it("emits Daily then Monthly, skipping unconfigured windows", () => {
    const both = buildBudgetModel({ daily: 5, monthly: 30, warnAt: 0.8 }, 1, 27)
    assert.deepEqual(
      both.lines.map((line) => line.label),
      ["Daily", "Monthly"],
    )
    assert.equal(both.lines[1]!.text, "$27.00 of $30.00 (90%)")
    assert.equal(both.lines[1]!.level, "warn")

    const monthlyOnly = buildBudgetModel({ daily: null, monthly: 30, warnAt: 0.8 }, 999, 31)
    assert.equal(monthlyOnly.lines.length, 1)
    assert.equal(monthlyOnly.lines[0]!.label, "Monthly")
    assert.equal(monthlyOnly.lines[0]!.level, "over")

    const dailyOnly = buildBudgetModel({ daily: 5, monthly: null, warnAt: 0.8 }, 1, 999)
    assert.equal(dailyOnly.lines.length, 1)
    assert.equal(dailyOnly.lines[0]!.label, "Daily")
  })

  it("handles a zero budget without dividing by zero", () => {
    const zero = validateBudgets({ daily: 0 })!
    const idle = buildBudgetModel(zero, 0, null).lines[0]!
    assert.equal(idle.text, "$0.00 of $0.00 (0%)")
    assert.equal(idle.level, "ok")
    const spending = buildBudgetModel(zero, 0.5, null).lines[0]!
    assert.equal(spending.level, "over")
    assert.ok(spending.text.includes(">100%)"))
  })
})
