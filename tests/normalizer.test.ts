import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  normalizeMessageUpdate,
  normalizeSessionEvent,
  normalizeStepFinish,
  providerReportsCache,
} from "../src/tracker/event-normalizer.ts"
import { EventDeduplicator } from "../src/tracker/event-deduplicator.ts"

function stepFinishPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "prt_abc123",
    sessionID: "ses_1",
    messageID: "msg_2",
    type: "step-finish",
    time: { created: 1786797000000 },
    tokens: { total: 1000, input: 400, output: 300, reasoning: 50, cache: { read: 200, write: 50 } },
    cost: 0.0123,
    ...overrides,
  }
}

describe("step-finish normalization", () => {
  it("extracts exact tokens, cost and attribution", () => {
    const event = normalizeStepFinish(
      { sessionID: "ses_1", part: stepFinishPart(), time: 1786797000000 },
      "prt_abc123",
      "anthropic",
      "claude-sonnet-4-6",
      "build",
    )
    assert.ok(event)
    assert.equal(event.eventKey, "ocp:prt_abc123")
    assert.equal(event.sessionId, "ses_1")
    assert.equal(event.messageId, "msg_2")
    assert.equal(event.provider, "anthropic")
    assert.equal(event.model, "claude-sonnet-4-6")
    assert.equal(event.agent, "build")
    assert.equal(event.inputTokens, 400)
    assert.equal(event.outputTokens, 300)
    assert.equal(event.reasoningTokens, 50)
    assert.equal(event.cacheReadTokens, 200)
    assert.equal(event.cacheWriteTokens, 50)
    assert.equal(event.totalTokens, 1000)
    assert.equal(event.cost, 0.0123)
    assert.equal(event.providerReportedCache, true)
  })

  it("returns null for non-step-finish parts", () => {
    const event = normalizeStepFinish(
      { sessionID: "ses_1", part: { id: "prt_1", type: "text", text: "hi" } },
      "prt_1",
      "anthropic",
      "m",
      "a",
    )
    assert.equal(event, null)
  })

  it("handles missing cache data without inventing values", () => {
    const part = stepFinishPart({ tokens: { total: 700, input: 700, output: 0, cache: {} } })
    const event = normalizeStepFinish({ sessionID: "ses_1", part }, "prt_1", "mistral", "mistral-large", "build")
    assert.ok(event)
    assert.equal(event.cacheReadTokens, 0)
    assert.equal(event.cacheWriteTokens, 0)
    assert.equal(event.providerReportedCache, false)
    assert.equal(event.totalTokens, 700)
  })

  it("handles zero-token responses", () => {
    const part = stepFinishPart({ tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 })
    const event = normalizeStepFinish({ sessionID: "ses_1", part }, "prt_1", "anthropic", "m", "a")
    assert.ok(event)
    assert.equal(event.inputTokens, 0)
    assert.equal(event.outputTokens, 0)
    assert.equal(event.cost, 0)
  })

  it("tolerates missing optional fields", () => {
    const part = stepFinishPart({ tokens: undefined, cost: undefined, time: undefined })
    const event = normalizeStepFinish({ sessionID: "ses_1", part }, "prt_1", undefined, undefined, undefined)
    assert.ok(event)
    assert.equal(event.totalTokens, 0)
    assert.equal(event.cost, null)
    assert.equal(event.provider, undefined)
  })

  it("clamps negative values to zero", () => {
    const part = stepFinishPart({ tokens: { input: -10, output: 5, cache: { read: -3 } } })
    const event = normalizeStepFinish({ sessionID: "ses_1", part }, "prt_1", "anthropic", "m", "a")
    assert.ok(event)
    assert.equal(event.inputTokens, 0)
    assert.equal(event.cacheReadTokens, 0)
    assert.equal(event.outputTokens, 5)
  })
})

describe("message normalization", () => {
  it("extracts assistant messages with model/provider/agent", () => {
    const record = normalizeMessageUpdate({
      sessionID: "ses_1",
      info: {
        id: "msg_9",
        role: "assistant",
        time: { created: 1000 },
        agent: "explore",
        modelID: "claude-sonnet-4-6",
        providerID: "anthropic",
      },
    })
    assert.ok(record)
    assert.equal(record.eventKey, "ocm:assistant:msg_9")
    assert.equal(record.role, "assistant")
    assert.equal(record.agent, "explore")
    assert.equal(record.provider, "anthropic")
    assert.equal(record.model, "claude-sonnet-4-6")
  })

  it("extracts user messages", () => {
    const record = normalizeMessageUpdate({
      sessionID: "ses_1",
      info: { id: "msg_1", role: "user", time: { created: 1000 }, agent: "build" },
    })
    assert.ok(record)
    assert.equal(record.role, "user")
    assert.equal(record.eventKey, "ocm:user:msg_1")
  })

  it("ignores unknown roles", () => {
    assert.equal(normalizeMessageUpdate({ sessionID: "ses_1", info: { id: "msg_1", role: "system" } }), null)
  })
})

describe("session normalization", () => {
  it("extracts parent sessions (subagent detection)", () => {
    const record = normalizeSessionEvent({
      sessionID: "ses_child",
      info: {
        id: "ses_child",
        projectID: "proj_1",
        parentID: "ses_parent",
        agent: "explore",
        title: "Subagent run",
        time: { created: 1000, updated: 2000 },
      },
    })
    assert.ok(record)
    assert.equal(record.parentId, "ses_parent")
    assert.equal(record.projectId, "proj_1")
  })
})

describe("provider cache capability", () => {
  it("knows cache-reporting providers", () => {
    assert.equal(providerReportsCache("anthropic"), true)
    assert.equal(providerReportsCache("deepseek"), true)
    assert.equal(providerReportsCache("openai"), true)
    assert.equal(providerReportsCache("ANTHROPIC"), true)
    assert.equal(providerReportsCache("mistral"), false)
    assert.equal(providerReportsCache("unknown-provider"), false)
    assert.equal(providerReportsCache(undefined), false)
  })
})

describe("event deduplicator", () => {
  it("dedupes in-flight keys", () => {
    const dedup = new EventDeduplicator()
    assert.equal(dedup.alreadySeen("ocp:a"), false)
    assert.equal(dedup.mark("ocp:a"), true)
    assert.equal(dedup.alreadySeen("ocp:a"), true)
    assert.equal(dedup.mark("ocp:a"), false)
    assert.equal(dedup.alreadySeen("ocp:b"), false)
  })

  it("bounds memory", () => {
    const dedup = new EventDeduplicator()
    for (let i = 0; i < 6000; i++) dedup.mark(`key-${i}`)
    // oldest keys evicted, newest retained
    assert.equal(dedup.alreadySeen("key-0"), false)
    assert.equal(dedup.alreadySeen("key-5999"), true)
  })
})
