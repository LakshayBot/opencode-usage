/**
 * Normalizes opencode bus events into our internal records.
 *
 * Verified payload shapes (opencode 1.18.18):
 *  - "message.part.updated"  -> { sessionID, part, time }  (part may be a
 *    step-finish part carrying `cost` + `tokens` { total?, input, output,
 *    reasoning, cache: { read, write } })
 *  - "message.updated"       -> { sessionID, info }        (info is a user or
 *    assistant message; assistant carries modelID/providerID/agent)
 *  - "session.created"       -> { sessionID, info }        (info = SessionInfo)
 *  - "session.updated"       -> { sessionID, info }
 */

import type { MessageRecord, SessionRecord, UsageEvent } from "../types/usage.ts"

export interface PartUpdatedPayload {
  sessionID?: string
  part?: Record<string, unknown>
  time?: number
}

export interface MessageUpdatedPayload {
  sessionID?: string
  info?: Record<string, unknown>
}

export interface SessionEventPayload {
  sessionID?: string
  info?: Record<string, unknown>
}

export interface StepTokens {
  total?: number
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/** Providers known to report prompt-cache token counts to opencode. */
export const CACHE_REPORTING_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "vertex",
  "bedrock",
  "deepseek",
  "openrouter",
  "venice",
])

export function providerReportsCache(provider: string | undefined): boolean {
  if (!provider) return false
  return CACHE_REPORTING_PROVIDERS.has(provider.toLowerCase())
}

const safe = (value: unknown): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0
  return Math.max(0, n)
}

const safeCost = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return value
}

const safeString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function timeField(info: Record<string, unknown>, field: string): number {
  const time = info.time
  if (time && typeof time === "object") {
    const value = (time as Record<string, unknown>)[field]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return 0
}

export type NormalizedEvent =
  | { kind: "usage"; event: UsageEvent }
  | { kind: "message"; record: MessageRecord }
  | { kind: "session"; record: SessionRecord }

/** Normalize a step-finish part update into a UsageEvent (null if not usable). */
export function normalizeStepFinish(
  payload: PartUpdatedPayload,
  partId: string,
  provider: string | undefined,
  model: string | undefined,
  agent: string | undefined,
): UsageEvent | null {
  const part = payload.part
  if (!part || part.type !== "step-finish") return null
  const tokens = (part.tokens ?? {}) as StepTokens
  const cache = (tokens.cache ?? {}) as StepTokens["cache"]

  const inputTokens = safe(tokens.input)
  const outputTokens = safe(tokens.output)
  const reasoningTokens = safe(tokens.reasoning)
  const cacheReadTokens = safe(cache?.read)
  const cacheWriteTokens = safe(cache?.write)
  const totalTokens = safe(tokens.total) || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens

  const timestamp = safe(payload.time) || Date.now()

  return {
    eventKey: `ocp:${partId}`,
    timestamp,
    sessionId: payload.sessionID ?? "unknown",
    messageId: safeString(part.messageID),
    provider,
    model,
    agent,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cost: safeCost(part.cost),
    estimatedInputCost: null,
    estimatedOutputCost: null,
    estimatedCacheReadCost: null,
    estimatedCacheWriteCost: null,
    estimatedTotalCost: null,
    providerReportedCache: providerReportsCache(provider),
    metadataJson: JSON.stringify({ part }),
  }
}

/** Normalize a message.updated event into a MessageRecord. */
export function normalizeMessageUpdate(payload: MessageUpdatedPayload): MessageRecord | null {
  const info = payload.info
  if (!info) return null
  const role = info.role
  if (role !== "user" && role !== "assistant") return null

  const messageId = safeString(info.id)
  if (!messageId) return null

  const model = safeString(info.modelID)
  const provider = safeString(info.providerID)
  const agent = safeString(info.agent)

  return {
    eventKey: `ocm:${role}:${messageId}`,
    timestamp: timeField(info, "created") || timeField(info, "start") || Date.now(),
    sessionId: payload.sessionID ?? "unknown",
    messageId,
    role,
    agent,
    provider,
    model,
  }
}

/** Normalize a session.created / session.updated event into a SessionRecord. */
export function normalizeSessionEvent(payload: SessionEventPayload): SessionRecord | null {
  const info = payload.info
  if (!info) return null
  const id = safeString(info.id)
  if (!id) return null

  return {
    id,
    projectId: safeString(info.projectID),
    parentId: safeString(info.parentID),
    agent: safeString(info.agent),
    title: safeString(info.title),
    created: timeField(info, "created"),
    updated: timeField(info, "updated") || Date.now(),
  }
}
