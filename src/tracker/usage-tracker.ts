/**
 * UsageTracker — the plugin-side capture engine.
 *
 * Consumes opencode bus events, normalizes them, attributes each model
 * request to a model/provider/agent, fills estimated cost components from the
 * pricing catalog, and writes to SQLite through an async queue.
 *
 * Reliability contract:
 *  - `handleEvent` returns immediately; all I/O happens on a background queue.
 *  - Writes are batched and wrapped in transactions.
 *  - Busy/locked databases are retried with backoff, then dropped with a log.
 *  - Errors are never thrown to the caller — tracking can never break opencode.
 */

import type { PricingProvider } from "../types/pricing.ts"
import type { MessageRecord, SessionRecord, UsageEvent } from "../types/usage.ts"
import { CostCalculator } from "../pricing/cost-calculator.ts"
import { UsageDatabase } from "../storage/database.ts"
import { EventDeduplicator } from "./event-deduplicator.ts"
import {
  type MessageUpdatedPayload,
  type PartUpdatedPayload,
  type SessionEventPayload,
  normalizeMessageUpdate,
  normalizeSessionEvent,
  normalizeStepFinish,
} from "./event-normalizer.ts"

export type LogFn = (level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown) => void

export interface TrackerOptions {
  dbPath: string
  pricing: PricingProvider
  log?: LogFn
  /** Flush interval in ms (default 500). */
  flushIntervalMs?: number
  /** Max queued writes before an immediate flush (default 200). */
  maxBatch?: number
}

interface PendingWrite {
  kind: "usage" | "message" | "session"
  payload: { kind: "usage"; event: UsageEvent } | { kind: "message"; record: MessageRecord } | { kind: "session"; record: SessionRecord }
}

export class UsageTracker {
  private options: Required<Pick<TrackerOptions, "dbPath">> & TrackerOptions
  private deduplicator = new EventDeduplicator()
  private db: UsageDatabase | null = null
  private queue: PendingWrite[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private disposed = false

  /** messageID -> attribution learned from message.updated events. */
  private messageAttribution = new Map<string, { provider?: string; model?: string; agent?: string }>()
  /** sessionID -> parent session id (subagent detection). */
  private sessionParents = new Map<string, string>()
  /** sessionID -> SessionRecord (title/project). */
  private sessions = new Map<string, SessionRecord>()
  /** Providers observed reporting nonzero cache tokens (custom gateways). */
  private providersSeenCache = new Set<string>()

  constructor(options: TrackerOptions) {
    this.options = {
      flushIntervalMs: 500,
      maxBatch: 200,
      ...options,
    }
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown) {
    try {
      this.options.log?.(level, message, extra)
    } catch {
      // logging must never throw either
    }
  }

  /** Entry point: handle any opencode bus event. Never throws. */
  handleEvent(event: { type: string; properties?: unknown }): void {
    if (this.disposed) return
    try {
      switch (event.type) {
        case "message.part.updated":
          this.handlePartUpdated(event.properties as PartUpdatedPayload)
          break
        case "message.updated":
          this.handleMessageUpdated(event.properties as MessageUpdatedPayload)
          break
        case "session.created":
        case "session.updated":
          this.handleSessionEvent(event.properties as SessionEventPayload)
          break
      }
    } catch (error) {
      this.log("error", "unhandled error processing event", { type: event.type, error: String(error) })
    }
  }

  private handlePartUpdated(payload: PartUpdatedPayload): void {
    const part = payload.part
    if (!part || typeof part.id !== "string") return
    const key = `ocp:${part.id}`
    if (this.deduplicator.alreadySeen(key)) return

    const attribution = typeof part.messageID === "string" ? this.messageAttribution.get(part.messageID) : undefined
    const parentId = payload.sessionID ? this.sessionParents.get(payload.sessionID) : undefined

    const event = normalizeStepFinish(
      payload,
      part.id,
      attribution?.provider,
      attribution?.model,
      attribution?.agent,
    )
    if (!event) return
    event.parentSessionId = parentId

    // Providers in the known capability list always count; providers observed
    // reporting nonzero cache tokens (custom gateways) are inferred. Zeros
    // from unknown providers stay "not available" — never assumed.
    const seenCache = event.cacheReadTokens + event.cacheWriteTokens > 0
    if (seenCache && event.provider) this.providersSeenCache.add(event.provider)
    if (!event.providerReportedCache && event.provider && this.providersSeenCache.has(event.provider)) {
      event.providerReportedCache = true
    }

    const pricing = this.options.pricing.getPricing(event.provider ?? "unknown", event.model ?? "unknown", event.timestamp)
    const calc = CostCalculator.forEvent(event, pricing)
    event.estimatedInputCost = calc.input
    event.estimatedOutputCost = calc.output
    event.estimatedCacheReadCost = calc.cacheRead
    event.estimatedCacheWriteCost = calc.cacheWrite
    event.estimatedTotalCost = calc.total

    this.deduplicator.mark(key)
    this.enqueue({ kind: "usage", payload: { kind: "usage", event } })
  }

  private handleMessageUpdated(payload: MessageUpdatedPayload): void {
    const record = normalizeMessageUpdate(payload)
    if (!record) return
    if (record.role === "assistant") {
      this.messageAttribution.set(record.messageId, {
        provider: record.provider,
        model: record.model,
        agent: record.agent,
      })
      // Attribute previously-inserted usage events whose model was unknown.
      // The step-finish of this message may still be sitting in the queue, so
      // flush pending writes first (best-effort; a no-op when the queue is
      // empty), then patch the rows.
      this.flushSync()
      this.backfillAttribution(record)
    }
    this.enqueue({ kind: "message", payload: { kind: "message", record } })
  }

  private backfillAttribution(record: { messageId: string; provider?: string; model?: string; agent?: string }): void {
    if (!this.db) return
    try {
      // 1. Attach provider/model/agent learned from the assistant message.
      this.db.raw
        .prepare(
          `UPDATE usage_events SET provider = COALESCE(provider, ?), model = COALESCE(model, ?), agent = COALESCE(agent, ?)
           WHERE message_id = ? AND (provider IS NULL OR model IS NULL OR agent IS NULL)`,
        )
        .run(record.provider ?? null, record.model ?? null, record.agent ?? null, record.messageId)

      // 2. Recompute cost estimates now that the model is known.
      const rows = this.db.raw
        .prepare(
          `SELECT event_key, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens
           FROM usage_events WHERE message_id = ? AND estimated_total_cost IS NULL`,
        )
        .all(record.messageId) as Array<Record<string, unknown>>
      const update = this.db.raw.prepare(
        `UPDATE usage_events SET estimated_input_cost = ?, estimated_output_cost = ?,
                estimated_cache_read_cost = ?, estimated_cache_write_cost = ?, estimated_total_cost = ?
         WHERE event_key = ?`,
      )
      for (const row of rows) {
        const pricing = this.options.pricing.getPricing(
          record.provider ?? "unknown",
          record.model ?? "unknown",
          Number(row.timestamp) || Date.now(),
        )
        const calc = CostCalculator.compute(
          {
            inputTokens: Number(row.input_tokens) || 0,
            outputTokens: (Number(row.output_tokens) || 0) + (Number(row.reasoning_tokens) || 0),
            cacheReadTokens: Number(row.cache_read_tokens) || 0,
            cacheWriteTokens: Number(row.cache_write_tokens) || 0,
          },
          pricing,
        )
        update.run(calc.input, calc.output, calc.cacheRead, calc.cacheWrite, calc.total, row.event_key)
      }
    } catch (error) {
      this.log("warn", "failed to backfill attribution", { error: String(error) })
    }
  }

  private handleSessionEvent(payload: SessionEventPayload): void {
    const record = normalizeSessionEvent(payload)
    if (!record) return
    if (record.parentId) this.sessionParents.set(record.id, record.parentId)
    this.sessions.set(record.id, record)
    this.enqueue({ kind: "session", payload: { kind: "session", record } })
  }

  private enqueue(write: PendingWrite): void {
    this.queue.push(write)
    if (this.queue.length >= (this.options.maxBatch ?? 200)) {
      this.scheduleFlush(0)
    } else if (!this.timer) {
      this.scheduleFlush(this.options.flushIntervalMs ?? 500)
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    try {
      const batch = this.queue
      this.queue = []
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          this.writeBatch(batch)
          return
        } catch (error) {
          const busy = String(error).includes("locked") || String(error).includes("busy")
          if (!busy || attempt === 3) {
            this.log("error", `dropping ${batch.length} usage events (tracking continues)`, { error: String(error) })
            return
          }
          this.log("warn", `database busy, retrying (${attempt}/3)`)
          await new Promise((resolve) => setTimeout(resolve, attempt * 150))
        }
      }
    } finally {
      this.flushing = false
      if (this.queue.length > 0) this.scheduleFlush(0)
    }
  }

  private writeBatch(batch: PendingWrite[]): void {
    const db = this.ensureDb()
    db.runInTransaction((tx) => {
      for (const write of batch) {
        switch (write.payload.kind) {
          case "usage":
            tx.insertUsageEvent(write.payload.event)
            break
          case "message":
            tx.insertMessageRecord(write.payload.record)
            break
          case "session":
            tx.upsertSessionRecord(write.payload.record)
            break
        }
      }
    })
  }

  private ensureDb(): UsageDatabase {
    if (!this.db) {
      this.db = UsageDatabase.open(this.options.dbPath, {
        log: (msg) => this.log("debug", msg),
      })
      // Seed tracking metadata so `status` can report when tracking began.
      if (!this.db.getMetadata("tracking_since")) {
        this.db.setMetadata("tracking_since", String(Date.now()))
      }
    }
    return this.db
  }

  /** Flush pending writes synchronously (best effort). Used on dispose. */
  flushSync(): void {
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    try {
      this.writeBatch(batch)
    } catch (error) {
      this.log("error", "final flush failed", { error: String(error) })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.flushSync()
    this.db?.close()
    this.db = null
  }
}
