import { describe, it } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { tmpDir, rmrf, createFakeOpencodeDb, pathsFor } from "./helpers.ts"
import { HistoricalImporter } from "../src/opencode/historical-importer.ts"
import { UsageDatabase } from "../src/storage/database.ts"

async function makeTarget() {
  const home = tmpDir("ocu-imp-home-")
  const data = tmpDir("ocu-imp-data-")
  const env = {
    HOME: home,
    XDG_DATA_HOME: path.join(data, "d"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(data, "s"),
    XDG_CACHE_HOME: path.join(data, "c"),
  }
  const paths = await pathsFor(env)
  return { paths, home, data }
}

describe("HistoricalImporter", () => {
  it("imports sessions, messages and step-finish events from a fake opencode.db", async () => {
    const { paths, home } = await makeTarget()
    try {
      const fakeDb = path.join(home, "opencode.db")
      createFakeOpencodeDb(fakeDb)

      const target = UsageDatabase.open(paths.usageDbPath)
      const importer = new HistoricalImporter(fakeDb)
      const result = importer.importAll(target)
      importer.close()
      target.close()

      assert.equal(result.sessionsFound, 2)
      assert.equal(result.eventsDiscovered, 2)
      assert.equal(result.newImported, 2)
      assert.equal(result.alreadyImported, 0)
      assert.equal(result.messagesImported, 4)

      const db = UsageDatabase.open(paths.usageDbPath, { readOnly: true })
      const events = db.raw.prepare("SELECT * FROM usage_events ORDER BY event_key").all() as Array<Record<string, unknown>>
      assert.equal(events.length, 2)
      const anthropic = events.find((e) => e.provider === "anthropic")
      assert.ok(anthropic)
      assert.equal(anthropic.model, "claude-sonnet-4-6")
      assert.equal(anthropic.agent, "build")
      assert.equal(anthropic.input_tokens, 5000)
      assert.equal(anthropic.cache_read_tokens, 30000)
      assert.equal(anthropic.provider_reported_cache, 1)
      assert.equal(anthropic.cost, 0.045)
      assert.equal(anthropic.message_id, "msg_2")

      const openai = events.find((e) => e.provider === "openai")
      assert.ok(openai)
      assert.equal(openai.provider_reported_cache, 1) // openai is cache-aware
      assert.equal(openai.cache_read_tokens, 0) // but zero was actually reported

      const sessions = db.raw.prepare("SELECT id, project_id, parent_id FROM sessions ORDER BY id").all() as Array<Record<string, unknown>>
      assert.equal(sessions.length, 2)
      assert.equal(sessions[0]!.project_id, "proj_a")
      db.close()
    } finally {
      rmrf(home)
    }
  })

  it("is idempotent: re-import reports everything as already imported", async () => {
    const { paths, home } = await makeTarget()
    try {
      const fakeDb = path.join(home, "opencode.db")
      createFakeOpencodeDb(fakeDb)
      const target = UsageDatabase.open(paths.usageDbPath)
      const importer = new HistoricalImporter(fakeDb)
      importer.importAll(target)
      const second = importer.importAll(target)
      importer.close()
      target.close()

      assert.equal(second.newImported, 0)
      assert.equal(second.alreadyImported, 2)
      const db = UsageDatabase.open(paths.usageDbPath, { readOnly: true })
      assert.equal(db.countUsageEvents(), 2)
      db.close()
    } finally {
      rmrf(home)
    }
  })

  it("deduplicates with live-tracked events (same part ids)", async () => {
    const { paths, home } = await makeTarget()
    try {
      const fakeDb = path.join(home, "opencode.db")
      createFakeOpencodeDb(fakeDb)
      const target = UsageDatabase.open(paths.usageDbPath)
      // Simulate an event already captured live by the tracker.
      target.insertUsageEvent({
        eventKey: "ocp:prt_1",
        timestamp: Date.now() - 3400_000,
        sessionId: "ses_1",
        messageId: "msg_2",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 5000,
        outputTokens: 1200,
        reasoningTokens: 300,
        cacheReadTokens: 30000,
        cacheWriteTokens: 500,
        totalTokens: 36500,
        cost: 0.045,
        estimatedInputCost: null,
        estimatedOutputCost: null,
        estimatedCacheReadCost: null,
        estimatedCacheWriteCost: null,
        estimatedTotalCost: null,
        providerReportedCache: true,
      })
      const importer = new HistoricalImporter(fakeDb)
      const result = importer.importAll(target)
      importer.close()
      target.close()

      assert.equal(result.eventsDiscovered, 2)
      assert.equal(result.alreadyImported, 1)
      assert.equal(result.newImported, 1)
    } finally {
      rmrf(home)
    }
  })

  it("respects the since filter", async () => {
    const { paths, home } = await makeTarget()
    try {
      const fakeDb = path.join(home, "opencode.db")
      createFakeOpencodeDb(fakeDb)
      const target = UsageDatabase.open(paths.usageDbPath)
      const importer = new HistoricalImporter(fakeDb)
      // ses_1 events are ~1h old, ses_2 ~24h old; filter to last 12h.
      const result = importer.importAll(target, { since: Date.now() - 12 * 3600_000 })
      importer.close()
      target.close()

      assert.equal(result.eventsDiscovered, 1)
      assert.equal(result.newImported, 1)
    } finally {
      rmrf(home)
    }
  })

  it("errors clearly when opencode.db is missing", async () => {
    const missing = path.join(tmpDir(), "nope.db")
    assert.throws(() => new HistoricalImporter(missing), /not found/)
  })
})
