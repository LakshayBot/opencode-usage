/**
 * Shared test helpers: temp dirs, fake opencode.db fixtures.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase } from "../src/storage/database.ts"
import type { Paths } from "../src/opencode/paths.ts"

export function tmpDir(prefix = "ocu-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

/** Paths pointing into a temp home + temp data dir. */
export function testPaths(env: Record<string, string | undefined> = {}): { env: Record<string, string | undefined>; home: string; data: string } {
  const home = tmpDir("ocu-home-")
  const data = tmpDir("ocu-data-")
  const merged: Record<string, string | undefined> = {
    HOME: home,
    XDG_DATA_HOME: path.join(data, "xdg-data"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(data, "xdg-state"),
    XDG_CACHE_HOME: path.join(data, "xdg-cache"),
    ...env,
  }
  return { env: merged, home, data }
}

export async function pathsFor(env: Record<string, string | undefined>): Promise<Paths> {
  const m = await import("../src/opencode/paths.ts")
  return m.resolvePaths(env)
}

export function openUsageDb(dbPath: string) {
  return openDatabase(dbPath)
}

/** Build a fake opencode.db with realistic session/message/part rows. */
export function createFakeOpencodeDb(dbPath: string): void {
  const db = openDatabase(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT, directory TEXT,
      path TEXT, title TEXT, version TEXT, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      metadata TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      revert TEXT, permission TEXT, agent TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `)
  const now = Date.now()
  const insertSession = db.prepare(`
    INSERT INTO session (id, project_id, parent_id, agent, title, cost, tokens_input, tokens_output,
                         tokens_cache_read, tokens_cache_write, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insertSession.run("ses_1", "proj_a", null, "build", "Session A", 0.045, 5000, 1200, 30000, 500, now - 3600_000, now - 600_000)
  insertSession.run("ses_2", "proj_b", null, "build", "Session B", 0.02, 2000, 800, 0, 0, now - 86_400_000, now - 70_000_000)

  const insertMessage = db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`)
  insertMessage.run(
    "msg_1",
    "ses_1",
    now - 3600_000,
    JSON.stringify({
      id: "msg_1",
      role: "user",
      time: { created: now - 3600_000 },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    }),
  )
  insertMessage.run(
    "msg_2",
    "ses_1",
    now - 3500_000,
    JSON.stringify({
      id: "msg_2",
      role: "assistant",
      time: { created: now - 3500_000, completed: now - 3400_000 },
      agent: "build",
      modelID: "claude-sonnet-4-6",
      providerID: "anthropic",
      cost: 0.045,
      tokens: { total: 36500, input: 5000, output: 1200, reasoning: 300, cache: { read: 30000, write: 500 } },
    }),
  )
  insertMessage.run(
    "msg_3",
    "ses_2",
    now - 86_400_000,
    JSON.stringify({
      id: "msg_3",
      role: "user",
      time: { created: now - 86_400_000 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-4o" },
    }),
  )
  insertMessage.run(
    "msg_4",
    "ses_2",
    now - 85_000_000,
    JSON.stringify({
      id: "msg_4",
      role: "assistant",
      time: { created: now - 85_000_000 },
      agent: "build",
      modelID: "gpt-4o",
      providerID: "openai",
      cost: 0.02,
      tokens: { total: 2800, input: 2000, output: 800, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  )

  const insertPart = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`)
  insertPart.run(
    "prt_1",
    "msg_2",
    "ses_1",
    now - 3400_000,
    JSON.stringify({
      id: "prt_1",
      type: "step-finish",
      reason: "tool_use",
      time: { created: now - 3400_000, end: now - 3390_000 },
      tokens: { total: 36500, input: 5000, output: 1200, reasoning: 300, cache: { read: 30000, write: 500 } },
      cost: 0.045,
    }),
  )
  insertPart.run(
    "prt_2",
    "msg_2",
    "ses_1",
    now - 3390_000,
    JSON.stringify({
      id: "prt_2",
      type: "text",
      time: { created: now - 3390_000 },
      text: "hello",
    }),
  )
  insertPart.run(
    "prt_3",
    "msg_4",
    "ses_2",
    now - 84_900_000,
    JSON.stringify({
      id: "prt_3",
      type: "step-finish",
      reason: "stop",
      time: { created: now - 84_900_000 },
      tokens: { total: 2800, input: 2000, output: 800, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.02,
    }),
  )
  db.close()
}

/** Insert realistic usage events directly (for report tests). */
export function seedUsageEvents(dbPath: string, now: number): void {
  const db = openUsageDb(dbPath)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_events (
      event_key, timestamp, session_id, message_id, project_id, parent_session_id,
      agent, provider, model,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens,
      cost, provider_reported_cache
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const events = [
    {
      key: "ocp:t1",
      ts: now - 3600_000,
      session: "ses_x",
      msg: "msg_x",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input: 1000,
      output: 500,
      reasoning: 100,
      cacheRead: 5000,
      cacheWrite: 200,
      total: 6800,
      cost: 0.01,
    },
    {
      key: "ocp:t2",
      ts: now - 7200_000,
      session: "ses_x",
      msg: "msg_y",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input: 2000,
      output: 300,
      reasoning: 0,
      cacheRead: 8000,
      cacheWrite: 100,
      total: 10400,
      cost: 0.02,
    },
    {
      key: "ocp:t3",
      ts: now - 30 * 24 * 3600_000,
      session: "ses_old",
      msg: "msg_old",
      provider: "openai",
      model: "gpt-4o",
      input: 500,
      output: 100,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 600,
      cost: 0.005,
    },
  ]
  for (const e of events) {
    insert.run(
      e.key,
      e.ts,
      e.session,
      e.msg,
      "proj_x",
      null,
      "build",
      e.provider,
      e.model,
      e.input,
      e.output,
      e.reasoning,
      e.cacheRead,
      e.cacheWrite,
      e.total,
      e.cost,
      1,
    )
  }
  db.close()
}
