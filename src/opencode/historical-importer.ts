/**
 * Historical import: reconstruct usage events from opencode's own database
 * (~/.local/share/opencode/opencode.db).
 *
 * Source tables (drizzle schema, verified in packages/core/src/session/sql.ts):
 *   part    (id TEXT PK, message_id, session_id, data TEXT json)  — step-finish
 *           parts carry `cost` + `tokens.{input,output,reasoning,cache.{read,write}}`
 *   message (id TEXT PK, session_id, data TEXT json)              — assistant
 *           messages carry modelID/providerID/agent
 *   session (id TEXT PK, project_id, parent_id, agent, title, time_created,
 *           time_updated)
 *
 * Dedup: every opencode part.id is globally unique, so events imported here
 * use event_key `ocp:<part_id>` — identical to live tracking. Re-running the
 * import is idempotent (INSERT OR IGNORE) and reports skipped counts.
 *
 * opencode.db is opened READ-ONLY. It is never modified.
 */

import fs from "node:fs"
import { openDatabase, UsageDatabase } from "../storage/database.ts"
import type { SqlDatabase } from "../storage/sql-driver.ts"
import { providerReportsCache } from "../tracker/event-normalizer.ts"
import type { MessageRecord, SessionRecord, UsageEvent } from "../types/usage.ts"

export interface ImportOptions {
  onProgress?: (done: number, total: number) => void
  /** Only import sessions newer than this timestamp. */
  since?: number
}

export interface ImportResult {
  sessionsFound: number
  eventsDiscovered: number
  alreadyImported: number
  newImported: number
  messagesImported: number
  opencodeDb: string
  skippedDueToError: number
}

const PART_BATCH = 2_000
const MESSAGE_BATCH = 2_000

export class HistoricalImporter {
  private source: SqlDatabase
  private sourcePath: string

  constructor(sourcePath: string) {
    this.sourcePath = sourcePath
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`opencode database not found: ${sourcePath}`)
    }
    this.source = openDatabase(sourcePath, { readOnly: true })
  }

  close(): void {
    if (this.source.isOpen) this.source.close()
  }

  /**
   * Import usage events from opencode.db into the usage database.
   * Returns counts; never throws for individual bad rows.
   */
  importAll(target: UsageDatabase, options: ImportOptions = {}): ImportResult {
    const result: ImportResult = {
      sessionsFound: 0,
      eventsDiscovered: 0,
      alreadyImported: 0,
      newImported: 0,
      messagesImported: 0,
      opencodeDb: this.sourcePath,
      skippedDueToError: 0,
    }

    // ---- sessions ---------------------------------------------------------
    const sessions = this.source
      .prepare(
        `SELECT id, project_id, parent_id, agent, title, time_created, time_updated
         FROM session`,
      )
      .all() as Array<{
      id: string
      project_id: string | null
      parent_id: string | null
      agent: string | null
      title: string | null
      time_created: number | null
      time_updated: number | null
    }>
    result.sessionsFound = sessions.length

    const sessionProject = new Map<string, string | undefined>()
    for (const row of sessions) {
      if (options.since && (row.time_created ?? 0) < options.since) continue
      const record: SessionRecord = {
        id: row.id,
        projectId: row.project_id ?? undefined,
        parentId: row.parent_id ?? undefined,
        agent: row.agent ?? undefined,
        title: row.title ?? undefined,
        created: row.time_created ?? 0,
        updated: row.time_updated ?? row.time_created ?? 0,
      }
      try {
        target.upsertSessionRecord(record)
      } catch {
        result.skippedDueToError += 1
      }
      if (row.project_id) sessionProject.set(row.id, row.project_id)
    }

    // ---- messages (model/provider/agent attribution) -----------------------
    const messageInfo = new Map<string, { modelID?: string; providerID?: string; agent?: string }>()
    let messageCursor = ""
    let hasMoreMessages = true
    while (hasMoreMessages) {
      const rows = this.source
        .prepare(
          `SELECT id, data FROM message
           WHERE id > ? ORDER BY id LIMIT ${MESSAGE_BATCH}`,
        )
        .all(messageCursor) as Array<{ id: string; data: string }>
      if (rows.length === 0) {
        hasMoreMessages = false
        break
      }
      messageCursor = rows[rows.length - 1]?.id ?? messageCursor
      for (const row of rows) {
        try {
          const info = JSON.parse(row.data) as Record<string, unknown>
          if (info.role === "assistant") {
            messageInfo.set(row.id, {
              modelID: typeof info.modelID === "string" ? info.modelID : undefined,
              providerID: typeof info.providerID === "string" ? info.providerID : undefined,
              agent: typeof info.agent === "string" ? info.agent : undefined,
            })
          }
        } catch {
          result.skippedDueToError += 1
        }
      }
    }

    // Also import user/assistant message counts when available.
    {
      let messageCursor2 = ""
      let hasMore = true
      while (hasMore) {
        const rows = this.source
          .prepare(
            `SELECT m.id, m.session_id, m.data, s.parent_id
             FROM message m LEFT JOIN session s ON s.id = m.session_id
             WHERE m.id > ? ORDER BY m.id LIMIT ${MESSAGE_BATCH}`,
          )
          .all(messageCursor2) as Array<{ id: string; session_id: string; data: string; parent_id: string | null }>
        if (rows.length === 0) {
          hasMore = false
          break
        }
        messageCursor2 = rows[rows.length - 1]?.id ?? messageCursor2
        const batch: MessageRecord[] = []
        for (const row of rows) {
          try {
            const info = JSON.parse(row.data) as Record<string, unknown>
            const role = info.role
            if (role !== "user" && role !== "assistant") continue
            const time = info.time as Record<string, unknown> | undefined
            const created = typeof time?.created === "number" ? time.created : 0
            if (options.since && created < options.since) continue
            batch.push({
              eventKey: `ocm:${role}:${row.id}`,
              timestamp: created || Date.now(),
              sessionId: row.session_id,
              messageId: row.id,
              role,
              agent: typeof info.agent === "string" ? info.agent : undefined,
              provider: typeof info.providerID === "string" ? info.providerID : undefined,
              model: typeof info.modelID === "string" ? info.modelID : undefined,
            })
          } catch {
            result.skippedDueToError += 1
          }
        }
        if (batch.length) {
          target.runInTransaction((tx) => {
            for (const record of batch) {
              if (tx.insertMessageRecord(record)) result.messagesImported += 1
            }
          })
        }
      }
    }

    // ---- step-finish parts -------------------------------------------------
    let partCursor = ""
    let hasMoreParts = true
    while (hasMoreParts) {
      const rows = this.source
        .prepare(
          `SELECT p.id, p.session_id, p.message_id, p.data
           FROM part p WHERE p.id > ? ORDER BY p.id LIMIT ${PART_BATCH}`,
        )
        .all(partCursor) as Array<{ id: string; session_id: string; message_id: string; data: string }>
      if (rows.length === 0) {
        hasMoreParts = false
        break
      }
      partCursor = rows[rows.length - 1]?.id ?? partCursor

      const batch: UsageEvent[] = []
      let discovered = 0
      for (const row of rows) {
        try {
          const data = JSON.parse(row.data) as Record<string, unknown>
          if (data.type !== "step-finish") continue
          const tokens = (data.tokens ?? {}) as { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
          const cache = tokens.cache ?? {}
          const info = messageInfo.get(row.message_id)
          const inputTokens = Math.max(0, typeof tokens.input === "number" ? tokens.input : 0)
          const outputTokens = Math.max(0, typeof tokens.output === "number" ? tokens.output : 0)
          const reasoningTokens = Math.max(0, typeof tokens.reasoning === "number" ? tokens.reasoning : 0)
          const cacheReadTokens = Math.max(0, typeof cache.read === "number" ? cache.read : 0)
          const cacheWriteTokens = Math.max(0, typeof cache.write === "number" ? cache.write : 0)
          const totalTokens =
            (typeof tokens.total === "number" ? tokens.total : 0) ||
            inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
          const time = data.time as Record<string, unknown> | undefined
          const timestamp =
            typeof time?.created === "number"
              ? time.created
              : typeof time?.end === "number"
                ? time.end
                : Date.now()
          if (options.since && timestamp < options.since) continue

          discovered += 1
          const provider = info?.providerID
          const model = info?.modelID
          const cost = typeof data.cost === "number" ? data.cost : null
          // Providers in the known capability list always count; providers
          // that demonstrably reported nonzero cache tokens are inferred.
          const reportedCache = providerReportsCache(provider) || cacheReadTokens + cacheWriteTokens > 0
          batch.push({
            eventKey: `ocp:${row.id}`,
            timestamp,
            sessionId: row.session_id,
            messageId: row.message_id,
            projectId: sessionProject.get(row.session_id),
            provider,
            model,
            agent: info?.agent,
            inputTokens,
            outputTokens,
            reasoningTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens,
            cost,
            estimatedInputCost: null,
            estimatedOutputCost: null,
            estimatedCacheReadCost: null,
            estimatedCacheWriteCost: null,
            estimatedTotalCost: null,
            providerReportedCache: reportedCache,
            metadataJson: JSON.stringify(data),
          })
        } catch {
          result.skippedDueToError += 1
        }
      }
      result.eventsDiscovered += discovered
      options.onProgress?.(result.eventsDiscovered, result.eventsDiscovered)

      if (batch.length) {
        target.runInTransaction((tx) => {
          for (const event of batch) {
            if (tx.insertUsageEvent(event)) result.newImported += 1
            else result.alreadyImported += 1
          }
        })
      }
    }

    // Data correction: any event whose provider demonstrably reported cache
    // tokens (non-zero cache read/write) must count towards cache stats, even
    // if it was imported before the capability inference existed.
    target.raw.exec(
      `UPDATE usage_events SET provider_reported_cache = 1
       WHERE provider_reported_cache = 0 AND (cache_read_tokens > 0 OR cache_write_tokens > 0)`,
    )

    return result
  }
}

export function openTargetDatabase(dbPath: string): UsageDatabase {
  return UsageDatabase.open(dbPath)
}
