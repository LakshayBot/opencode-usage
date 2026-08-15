/**
 * SQLite storage layer.
 *
 * Runs in two runtimes via a driver abstraction (src/storage/sql-driver.ts):
 *  - Node >= 23.4 (CLI): `node:sqlite`.
 *  - Bun (opencode plugin process): `bun:sqlite` (opencode's Bun does not
 *    implement node:sqlite — verified empirically on 1.18.18).
 *
 * Schema is versioned via `PRAGMA user_version` and migrated forward only.
 * Never destroys data: new migrations only ADD tables/columns/indexes.
 */

import fs from "node:fs"
import path from "node:path"
import type { MessageRecord, SessionRecord, UsageEvent } from "../types/usage.ts"
import { openSqlDatabase, type SqlDatabase, type SqlStatement } from "./sql-driver.ts"

export const SCHEMA_VERSION = 1

export const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE usage_events (
    event_key                TEXT PRIMARY KEY,
    timestamp                INTEGER NOT NULL,
    session_id               TEXT NOT NULL,
    message_id               TEXT,
    project_id               TEXT,
    parent_session_id        TEXT,
    agent                    TEXT,
    provider                 TEXT,
    model                    TEXT,
    input_tokens             INTEGER NOT NULL DEFAULT 0,
    output_tokens            INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens        INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens       INTEGER NOT NULL DEFAULT 0,
    total_tokens             INTEGER NOT NULL DEFAULT 0,
    cost                     REAL,
    estimated_input_cost     REAL,
    estimated_output_cost    REAL,
    estimated_cache_read_cost  REAL,
    estimated_cache_write_cost REAL,
    estimated_total_cost     REAL,
    provider_reported_cache  INTEGER NOT NULL DEFAULT 0,
    metadata_json            TEXT
  );

  CREATE INDEX idx_usage_timestamp   ON usage_events(timestamp);
  CREATE INDEX idx_usage_session     ON usage_events(session_id);
  CREATE INDEX idx_usage_provider    ON usage_events(provider);
  CREATE INDEX idx_usage_model       ON usage_events(model);
  CREATE INDEX idx_usage_project     ON usage_events(project_id);

  CREATE TABLE messages (
    event_key  TEXT PRIMARY KEY,
    timestamp  INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    agent      TEXT,
    provider   TEXT,
    model      TEXT
  );

  CREATE INDEX idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX idx_messages_session   ON messages(session_id);
  CREATE INDEX idx_messages_role      ON messages(role);

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    project_id TEXT,
    parent_id  TEXT,
    agent      TEXT,
    title      TEXT,
    created    INTEGER NOT NULL,
    updated    INTEGER NOT NULL
  );

  CREATE INDEX idx_sessions_updated ON sessions(updated);

  CREATE TABLE pricing_history (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    provider               TEXT NOT NULL,
    model                  TEXT NOT NULL,
    input_per_million      REAL,
    output_per_million     REAL,
    cache_read_per_million REAL,
    cache_write_per_million REAL,
    effective_from         INTEGER NOT NULL,
    effective_until        INTEGER,
    source                 TEXT NOT NULL,
    UNIQUE(provider, model, effective_from)
  );

  CREATE INDEX idx_pricing_lookup ON pricing_history(provider, model, effective_from);

  CREATE TABLE tracking_metadata (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  `,
]

export function migrate(db: SqlDatabase, log: (msg: string) => void = () => {}): void {
  const current = db.prepare("PRAGMA user_version").get() as { user_version: number }
  const version = current.user_version
  for (let i = version; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]
    if (!sql) continue
    log(`opencode-usage: running migration ${i + 1}/${MIGRATIONS.length}`)
    db.exec("BEGIN")
    try {
      db.exec(sql)
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
}

export interface DbOptions {
  /** Open read-only. Used by the historical importer. */
  readOnly?: boolean
  log?: (msg: string) => void
}

export function openDatabase(dbPath: string, options: DbOptions = {}): SqlDatabase {
  const readOnly = options.readOnly === true
  if (readOnly) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database not found: ${dbPath}`)
    }
    return openSqlDatabase(dbPath, { readOnly: true })
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = openSqlDatabase(dbPath)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA synchronous = NORMAL")
  migrate(db, options.log)
  return db
}

export class UsageDatabase {
  private db: SqlDatabase
  private insertEvent: SqlStatement
  private insertMessage: SqlStatement
  private upsertSession: SqlStatement
  private setMetadataStmt: SqlStatement
  private getMetadataStmt: SqlStatement

  constructor(db: SqlDatabase) {
    this.db = db
    this.insertEvent = db.prepare(`
      INSERT OR IGNORE INTO usage_events (
        event_key, timestamp, session_id, message_id, project_id, parent_session_id,
        agent, provider, model,
        input_tokens, output_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens,
        cost,
        estimated_input_cost, estimated_output_cost,
        estimated_cache_read_cost, estimated_cache_write_cost,
        estimated_total_cost,
        provider_reported_cache, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertMessage = db.prepare(`
      INSERT OR IGNORE INTO messages (event_key, timestamp, session_id, message_id, role, agent, provider, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.upsertSession = db.prepare(`
      INSERT INTO sessions (id, project_id, parent_id, agent, title, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = COALESCE(excluded.project_id, sessions.project_id),
        parent_id  = COALESCE(excluded.parent_id, sessions.parent_id),
        agent      = COALESCE(excluded.agent, sessions.agent),
        title      = COALESCE(excluded.title, sessions.title),
        updated    = MAX(sessions.updated, excluded.updated)
    `)
    this.setMetadataStmt = db.prepare(`
      INSERT INTO tracking_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    this.getMetadataStmt = db.prepare(`SELECT value FROM tracking_metadata WHERE key = ?`)
  }

  static open(dbPath: string, options: DbOptions = {}): UsageDatabase {
    return new UsageDatabase(openDatabase(dbPath, options))
  }

  get raw(): SqlDatabase {
    return this.db
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  insertUsageEvent(event: UsageEvent): boolean {
    const result = this.insertEvent.run(
      event.eventKey,
      event.timestamp,
      event.sessionId,
      event.messageId ?? null,
      event.projectId ?? null,
      event.parentSessionId ?? null,
      event.agent ?? null,
      event.provider ?? null,
      event.model ?? null,
      event.inputTokens,
      event.outputTokens,
      event.reasoningTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.totalTokens,
      event.cost,
      event.estimatedInputCost ?? null,
      event.estimatedOutputCost ?? null,
      event.estimatedCacheReadCost ?? null,
      event.estimatedCacheWriteCost ?? null,
      event.estimatedTotalCost ?? null,
      event.providerReportedCache ? 1 : 0,
      event.metadataJson ?? null,
    )
    return result.changes > 0
  }

  insertMessageRecord(record: MessageRecord): boolean {
    const result = this.insertMessage.run(
      record.eventKey,
      record.timestamp,
      record.sessionId,
      record.messageId,
      record.role,
      record.agent ?? null,
      record.provider ?? null,
      record.model ?? null,
    )
    return result.changes > 0
  }

  upsertSessionRecord(record: SessionRecord): void {
    this.upsertSession.run(
      record.id,
      record.projectId ?? null,
      record.parentId ?? null,
      record.agent ?? null,
      record.title ?? null,
      record.created,
      record.updated,
    )
  }

  getMetadata(key: string): string | null {
    const row = this.getMetadataStmt.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMetadata(key: string, value: string): void {
    this.setMetadataStmt.run(key, value)
  }

  countUsageEvents(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number }
    return row.n
  }

  countMessages(role?: "user" | "assistant"): number {
    const row = role
      ? (this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = ?").get(role) as { n: number })
      : (this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number })
    return row.n
  }

  firstEventTimestamp(): number | null {
    const row = this.db.prepare("SELECT MIN(timestamp) AS t FROM usage_events").get() as { t: number | null }
    return row.t ?? null
  }

  lastActivityTimestamp(): number | null {
    const row = this.db
      .prepare("SELECT MAX(timestamp) AS t FROM (SELECT timestamp FROM usage_events UNION ALL SELECT timestamp FROM messages)")
      .get() as { t: number | null }
    return row.t ?? null
  }

  runInTransaction(fn: (db: UsageDatabase) => void): void {
    this.db.exec("BEGIN")
    try {
      fn(this)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}

/** Reset the entire usage database (used by `reset` with confirmation). */
export function wipeDatabase(dbPath: string): void {
  const db = openDatabase(dbPath)
  db.exec("BEGIN")
  try {
    db.exec("DELETE FROM usage_events")
    db.exec("DELETE FROM messages")
    db.exec("DELETE FROM sessions")
    db.exec("DELETE FROM tracking_metadata")
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  db.close()
}
