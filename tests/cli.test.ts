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

  it("parseFlags never lets a valueless flag swallow the period after it", () => {
    // regression: `export --csv week` used to parse as csv="week" + no period,
    // silently exporting 'all' instead of the requested week
    assert.deepEqual(parseFlags(["--csv", "week"]), { positional: ["week"], flags: { csv: true } })
    assert.deepEqual(parseFlags(["--json", "week"]), { positional: ["week"], flags: { json: true } })
    assert.deepEqual(parseFlags(["--csv", "--json", "week"]), {
      positional: ["week"],
      flags: { csv: true, json: true },
    })
    assert.deepEqual(parseFlags(["week", "--csv"]), { positional: ["week"], flags: { csv: true } })
    assert.deepEqual(parseFlags(["uninstall", "--purge", "note"]), {
      positional: ["uninstall", "note"],
      flags: { purge: true },
    })
  })

  it("parseFlags still consumes values for value-taking flags", () => {
    assert.deepEqual(parseFlags(["--out", "f.csv", "week"]), { positional: ["week"], flags: { out: "f.csv" } })
    assert.deepEqual(parseFlags(["--out=f.csv", "week"]), { positional: ["week"], flags: { out: "f.csv" } })
    // dangling flag with nothing after it stays truthy rather than crashing
    assert.deepEqual(parseFlags(["export", "--out"]), { positional: ["export"], flags: { out: true } })
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
