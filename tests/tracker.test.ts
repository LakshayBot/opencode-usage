import { describe, it } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { tmpDir, rmrf, pathsFor, seedUsageEvents } from "./helpers.ts"
import { UsageDatabase } from "../src/storage/database.ts"
import { UsageTracker } from "../src/tracker/usage-tracker.ts"
import { CatalogPricingProvider } from "../src/pricing/cost-calculator.ts"

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function makeTracker(dir: string): Promise<{ tracker: UsageTracker; dbPath: string }> {
  const paths = await pathsFor({ HOME: dir, XDG_DATA_HOME: path.join(dir, "data") })
  const tracker = new UsageTracker({
    dbPath: paths.usageDbPath,
    pricing: new CatalogPricingProvider(),
    flushIntervalMs: 30,
  })
  return { tracker, dbPath: paths.usageDbPath }
}

describe("UsageTracker end-to-end", () => {
  it("captures user messages, assistant messages, sessions and step-finish usage", async () => {
    const dir = tmpDir()
    try {
      const { tracker, dbPath } = await makeTracker(dir)
      const t = 1786797000000

      tracker.handleEvent({
        type: "session.created",
        properties: {
          sessionID: "ses_1",
          info: { id: "ses_1", projectID: "proj_a", time: { created: t, updated: t }, agent: "build" },
        },
      })
      tracker.handleEvent({
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "msg_1", role: "user", time: { created: t }, agent: "build" },
        },
      })
      // step-finish arrives BEFORE its assistant message update (real order)
      tracker.handleEvent({
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          time: t + 1000,
          part: {
            id: "prt_1",
            messageID: "msg_2",
            type: "step-finish",
            time: { created: t + 1000 },
            tokens: { total: 12000, input: 2000, output: 1000, reasoning: 200, cache: { read: 8000, write: 800 } },
            cost: 0.025,
          },
        },
      })
      tracker.handleEvent({
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: {
            id: "msg_2",
            role: "assistant",
            time: { created: t + 1000, completed: t + 2000 },
            agent: "build",
            modelID: "claude-sonnet-4-6",
            providerID: "anthropic",
          },
        },
      })

      await waitFor(150)
      tracker.dispose()

      const db = UsageDatabase.open(dbPath, { readOnly: true })
      const events = db.raw.prepare("SELECT * FROM usage_events").all() as Array<Record<string, unknown>>
      assert.equal(events.length, 1)
      const event = events[0]!
      assert.equal(event.provider, "anthropic")
      assert.equal(event.model, "claude-sonnet-4-6")
      assert.equal(event.agent, "build")
      assert.equal(event.input_tokens, 2000)
      assert.equal(event.output_tokens, 1000)
      assert.equal(event.cache_read_tokens, 8000)
      assert.equal(event.cache_write_tokens, 800)
      assert.equal(event.cost, 0.025)
      // estimates filled from catalog at capture time
      assert.equal(typeof event.estimated_total_cost, "number")

      const messages = db.raw.prepare("SELECT role FROM messages ORDER BY role").all() as Array<{ role: string }>
      assert.deepEqual(messages.map((m) => m.role).sort(), ["assistant", "user"])

      const sessions = db.raw.prepare("SELECT id, project_id FROM sessions").all() as Array<Record<string, unknown>>
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0]!.project_id, "proj_a")

      db.close()
    } finally {
      rmrf(dir)
    }
  })

  it("dedupes re-emitted events (session replay)", async () => {
    const dir = tmpDir()
    try {
      const { tracker, dbPath } = await makeTracker(dir)
      const part = {
        id: "prt_dup",
        messageID: "msg_2",
        type: "step-finish",
        time: { created: 1000 },
        tokens: { total: 100, input: 100, output: 0, cache: { read: 0, write: 0 } },
        cost: 0.001,
      }
      for (let i = 0; i < 5; i++) {
        tracker.handleEvent({
          type: "message.part.updated",
          properties: { sessionID: "ses_1", part, time: 1000 },
        })
      }
      await waitFor(150)
      tracker.dispose()
      const db = UsageDatabase.open(dbPath, { readOnly: true })
      const count = (db.raw.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number }).n
      assert.equal(count, 1)
      db.close()
    } finally {
      rmrf(dir)
    }
  })

  it("tolerates garbage events without throwing", async () => {
    const dir = tmpDir()
    try {
      const { tracker } = await makeTracker(dir)
      tracker.handleEvent({ type: "message.part.updated", properties: null })
      tracker.handleEvent({ type: "totally.unknown", properties: { x: 1 } })
      tracker.handleEvent({ type: "message.updated", properties: { info: "not-an-object" } })
      tracker.handleEvent({ type: "session.created" })
      tracker.dispose()
    } finally {
      rmrf(dir)
    }
  })

  it("seeds tracking metadata on first write", async () => {
    const dir = tmpDir()
    try {
      const { tracker, dbPath } = await makeTracker(dir)
      tracker.handleEvent({
        type: "message.updated",
        properties: { sessionID: "s1", info: { id: "m1", role: "user", time: { created: 1 } } },
      })
      await waitFor(150)
      tracker.dispose()
      const db = UsageDatabase.open(dbPath, { readOnly: true })
      const since = db.getMetadata("tracking_since")
      assert.ok(since && Number(since) > 0)
      db.close()
    } finally {
      rmrf(dir)
    }
  })
})

describe("UsageDatabase storage", () => {
  it("round-trips seeded events and computes aggregates", async () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const now = Date.now()
      seedUsageEvents(dbPath, now)

      const db = UsageDatabase.open(dbPath, { readOnly: true })
      const count = db.countUsageEvents()
      assert.equal(count, 3)
      const first = db.firstEventTimestamp()
      assert.ok(first && first <= now - 30 * 24 * 3600_000)
      db.close()
    } finally {
      rmrf(dir)
    }
  })

  it("migrates fresh databases to the latest version", async () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const db = UsageDatabase.open(dbPath)
      const version = (db.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      assert.equal(version, 1)
      const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
      for (const table of ["usage_events", "messages", "sessions", "pricing_history", "tracking_metadata"]) {
        assert.ok(tables.includes(table), `missing table ${table}`)
      }
      db.close()
    } finally {
      rmrf(dir)
    }
  })

  it("re-opening an existing database does not re-run migrations", async () => {
    const dir = tmpDir()
    try {
      const dbPath = path.join(dir, "usage.db")
      const db = UsageDatabase.open(dbPath)
      db.setMetadata("marker", "kept")
      db.close()
      const db2 = UsageDatabase.open(dbPath)
      assert.equal(db2.getMetadata("marker"), "kept")
      const version = (db2.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      assert.equal(version, 1)
      db2.close()
    } finally {
      rmrf(dir)
    }
  })
})
