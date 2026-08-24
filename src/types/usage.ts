/**
 * Core data types for opencode-usage.
 *
 * All types are plain data structures shared by the CLI, the opencode server
 * plugin bundle, and the TUI plugin bundle.
 */

/** A single model request (one LLM step), normalized from opencode events. */
export interface UsageEvent {
  /** Globally unique dedup key, e.g. `ocp:<opencode part id>`. */
  eventKey: string
  /** Unix ms timestamp of the event. */
  timestamp: number
  sessionId: string
  messageId?: string
  projectId?: string
  /** Set when the event belongs to a subagent (child) session. */
  parentSessionId?: string
  agent?: string
  provider?: string
  model?: string

  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number

  /**
   * Exact estimated cost as computed by opencode at time of use
   * (models.dev pricing, applied then). May be null when opencode could not
   * compute a cost (e.g. failed step or unknown model).
   */
  cost: number | null

  /** Cost breakdown estimated with catalog pricing at capture time (may be null). */
  estimatedInputCost: number | null
  estimatedOutputCost: number | null
  estimatedCacheReadCost: number | null
  estimatedCacheWriteCost: number | null
  estimatedTotalCost: number | null

  /** 1 when the provider is known to report cache tokens (explicit zeros are real). */
  providerReportedCache: boolean

  /** Raw opencode tokens object, kept for auditing. */
  metadataJson?: string
}

/** A user or assistant message (for message counting). */
export interface MessageRecord {
  eventKey: string
  timestamp: number
  sessionId: string
  messageId: string
  role: "user" | "assistant"
  agent?: string
  provider?: string
  model?: string
}

/** A session, tracked from `session.created` / `session.updated`. */
export interface SessionRecord {
  id: string
  projectId?: string
  parentId?: string
  agent?: string
  title?: string
  created: number
  updated: number
}

/** Period selector for reports. */
export type ReportPeriod =
  | { kind: "session"; sessionId: string }
  | { kind: "today" }
  | { kind: "week" }
  | { kind: "month" }
  | { kind: "all" }

export type ReportFilter = {
  /** Substring match against provider name. */
  provider?: string
  /** Substring match against model id. */
  model?: string
}

export interface ModelRow {
  provider: string
  model: string
  requests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cost: number | null
}

export interface ProviderRow {
  provider: string
  requests: number
  totalTokens: number
  cost: number | null
}

export interface AgentRow {
  agent: string
  requests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cost: number | null
}

export interface ProjectRow {
  project: string
  requests: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cost: number | null
}

/** One session's aggregated usage within the report period. */
export interface SessionRow {
  sessionId: string
  /** Title joined from `sessions` ('(untitled)' when no row exists). */
  title: string
  requests: number
  totalTokens: number
  cost: number | null
  /** Unix ms of the session's most recent usage event. */
  lastActivity: number
}

export interface UsageReport {
  period: ReportPeriod
  periodLabel: string

  counts: {
    userMessages: number
    assistantMessages: number
    modelRequests: number
    sessions: number
    mainAgentRequests: number
    subagentRequests: number
    systemRequests: number
  }

  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    total: number
    /** input + cacheRead + cacheWrite (gross input, incl. cached) */
    grossInput: number
  }

  cache: {
    /** True when every model request in the period came from a cache-reporting provider. */
    available: boolean
    /** cacheRead / (cacheRead + nonCachedInput), computed over cache-reporting events only. */
    hitRate: number | null
    cacheReadTokens: number
    cacheWriteTokens: number
    estimatedSavings: number | null
  }

  cost: {
    /** Sum of opencode-computed costs at time of use (may be null if unavailable). */
    exact: number | null
    /** Re-computed breakdown with current catalog prices; null components = unknown. */
    breakdown: {
      input: number | null
      output: number | null
      cacheRead: number | null
      cacheWrite: number | null
    }
    /** Sum of breakdown components (null if any component is null). */
    total: number | null
    /** True when no pricing data exists for every model in the period. */
    unknown: boolean
  }

  perModel: ModelRow[]
  perProvider: ProviderRow[]
  perAgent: AgentRow[]
  perProject: ProjectRow[]
  /** Cost desc (unknown last), token volume tiebreak, capped at the top 50. */
  perSession: SessionRow[]

  averages: {
    /** Gross input tokens (incl. cache) per user message. */
    inputTokensPerUserMessage: number | null
    /** Output tokens per assistant response. */
    outputTokensPerAssistantResponse: number | null
  }

  topModels: {
    mostUsed: ModelRow | null
    mostExpensive: ModelRow | null
  }

  largestRequest: {
    totalTokens: number
    inputTokens: number
    outputTokens: number
    provider: string | null
    model: string | null
    timestamp: number
  } | null

  tracking: {
    startedAt: number | null
    lastActivity: number | null
  }
}
