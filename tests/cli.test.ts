import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseFlags, parseFilter, parsePeriod } from "../src/cli/index.ts"

describe("CLI arg parsing", () => {
  it("parseFlags handles --yes, --flag=value and --flag value", () => {
    const { positional, flags } = parseFlags(["install", "--yes", "--db=/x", "--since", "2026-01-01", "-y"])
    assert.deepEqual(positional, ["install"])
    assert.equal(flags.yes, true)
    assert.equal(flags.db, "/x")
    assert.equal(flags.since, "2026-01-01")
  })

  it("parsePeriod maps aliases", () => {
    assert.deepEqual(parsePeriod("today"), { kind: "today" })
    assert.deepEqual(parsePeriod("week"), { kind: "week" })
    assert.deepEqual(parsePeriod("month"), { kind: "month" })
    assert.deepEqual(parsePeriod("all"), { kind: "all" })
    assert.deepEqual(parsePeriod(undefined), { kind: "session", sessionId: "current" })
    assert.deepEqual(parsePeriod("session", "ses_1"), { kind: "session", sessionId: "ses_1" })
  })

  it("parseFilter extracts model/provider pairs", () => {
    const { filter, rest } = parseFilter(["week", "model", "claude-sonnet", "provider", "anthropic"])
    assert.equal(filter.model, "claude-sonnet")
    assert.equal(filter.provider, "anthropic")
    assert.deepEqual(rest, ["week"])
  })
})
