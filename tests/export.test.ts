import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { tmpDir, rmrf, seedUsageEvents } from "./helpers.ts"
import { csvEscape, runExport } from "../src/cli/export.ts"

const DAILY_HEADER = "label,start,end,input_tokens,output_tokens,total_tokens,cost"
const MODELS_HEADER = "provider,model,requests,input_tokens,output_tokens,total_tokens,cost"

/** Seed a usage db (2 events today for claude-sonnet, 1 event 30d ago for gpt-4o). */
const NOW = Date.now()

function setup(): { dir: string; dbPath: string } {
  const dir = tmpDir()
  const dbPath = path.join(dir, "usage.db")
  seedUsageEvents(dbPath, NOW)
  return { dir, dbPath }
}

function exportToFile(dbPath: string, flags: Record<string, string | boolean>, args: string[] = []): string {
  const file = path.join(path.dirname(dbPath), `export-out-${args.join("-") || "default"}-${flags.csv ? "csv" : "json"}.txt`)
  runExport({ dbPath, flags: { ...flags, out: file }, args, now: NOW })
  return fs.readFileSync(file, "utf8")
}

describe("csvEscape", () => {
  it("leaves plain fields unchanged", () => {
    assert.equal(csvEscape("hello"), "hello")
    assert.equal(csvEscape("claude-sonnet-4-6"), "claude-sonnet-4-6")
    assert.equal(csvEscape(""), "")
    assert.equal(csvEscape(null), "")
  })

  it("stringifies numbers", () => {
    assert.equal(csvEscape(42), "42")
    assert.equal(csvEscape(0.005), "0.005")
    assert.equal(csvEscape(17200), "17200")
  })

  it("wraps fields containing commas", () => {
    assert.equal(csvEscape("Session A, continued"), '"Session A, continued"')
  })

  it("wraps fields containing quotes and doubles embedded quotes", () => {
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""')
  })

  it("wraps fields containing newlines and carriage returns", () => {
    assert.equal(csvEscape("line1\nline2"), '"line1\nline2"')
    assert.equal(csvEscape("line1\rline2"), '"line1\rline2"')
  })
})

describe("runExport --json", () => {
  it("emits a single object with period/generatedAt/daily/models", () => {
    const { dir, dbPath } = setup()
    try {
      const doc = JSON.parse(exportToFile(dbPath, {})) as Record<string, unknown>
      assert.deepEqual(Object.keys(doc).sort(), ["daily", "generatedAt", "models", "period"])
      assert.equal(doc.period, "All Time")
      assert.equal(typeof doc.generatedAt, "string")
      assert.ok(!Number.isNaN(Date.parse(doc.generatedAt as string)))
      assert.ok((doc.generatedAt as string).endsWith("Z"))
      assert.ok(Array.isArray(doc.daily))
      assert.ok(Array.isArray(doc.models))

      const daily = doc.daily as Array<Record<string, unknown>>
      const bucket = daily.find((b) => b.totalTokens !== 0)
      assert.ok(bucket, "at least one non-empty bucket")
      assert.deepEqual(Object.keys(bucket).sort(), [
        "cost",
        "end",
        "inputTokens",
        "label",
        "outputTokens",
        "start",
        "totalTokens",
      ])

      const models = doc.models as Array<Record<string, unknown>>
      const claude = models.find((m) => m.model === "claude-sonnet-4-6")
      assert.ok(claude, "claude model row present")
      assert.deepEqual(Object.keys(claude).sort(), [
        "cost",
        "inputTokens",
        "model",
        "outputTokens",
        "provider",
        "requests",
        "totalTokens",
      ])
      assert.equal(claude.requests, 2)
      assert.equal(claude.inputTokens, 3000)
      assert.equal(claude.outputTokens, 800)
      assert.equal(claude.totalTokens, 17200)
    } finally {
      rmrf(dir)
    }
  })

  it("sums daily buckets to the period totals", () => {
    const { dir, dbPath } = setup()
    try {
      const doc = JSON.parse(exportToFile(dbPath, {}, ["week"])) as {
        daily: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }>
        models: unknown[]
      }
      assert.equal(doc.period, "Last 7 Days")
      const sum = (key: "inputTokens" | "outputTokens" | "totalTokens") =>
        doc.daily.reduce((acc, b) => acc + b[key], 0)
      assert.equal(sum("inputTokens"), 3000)
      assert.equal(sum("outputTokens"), 800)
      assert.equal(sum("totalTokens"), 17200)
      assert.equal(doc.models.length, 1)
    } finally {
      rmrf(dir)
    }
  })
})

describe("runExport --csv", () => {
  it("emits two sections separated by a blank line with exact headers", () => {
    const { dir, dbPath } = setup()
    try {
      const csv = exportToFile(dbPath, { csv: true }, ["all"])
      assert.ok(csv.endsWith("\n"))
      const raw = csv.split("\n")
      assert.equal(raw[raw.length - 1], "")
      const lines = raw.slice(0, -1)
      assert.equal(lines[0], "# daily buckets")
      assert.equal(lines[1], DAILY_HEADER)

      const blank = lines.indexOf("")
      assert.ok(blank > 1, "blank separator present after daily rows")
      assert.equal(lines[blank + 1], "# models")
      assert.equal(lines[blank + 2], MODELS_HEADER)

      // exactly one blank line, separating the two sections
      assert.equal(lines.filter((l) => l === "").length, 1)

      // data rows keep the declared column count
      for (let i = 2; i < blank; i++) {
        assert.equal(lines[i]?.split(",").length, 7, `daily row ${i}: ${lines[i]}`)
      }
      for (let i = blank + 3; i < lines.length; i++) {
        assert.equal(lines[i]?.split(",").length, 7, `model row ${i}: ${lines[i]}`)
      }

      const modelCsv = lines.slice(blank + 3).join("\n")
      assert.match(modelCsv, /^anthropic,claude-sonnet-4-6,2,/)
      assert.match(modelCsv, /openai,gpt-4o,1,/)
    } finally {
      rmrf(dir)
    }
  })

  it("escapes cells containing separators so column counts survive", () => {
    const { dir, dbPath } = setup()
    try {
      // A session title never reaches the CSV, but labels/quotes are covered
      // by the csvEscape matrix above; here we pin the end-to-end invariant.
      const csv = exportToFile(dbPath, { csv: true }, ["today"])
      const lines = csv.trimEnd().split("\n")
      const dataRows = lines.filter((l) => l !== "" && !l.startsWith("#") && l !== DAILY_HEADER && l !== MODELS_HEADER)
      assert.ok(dataRows.length > 0)
      for (const row of dataRows) {
        if (!row.startsWith(`"`)) assert.equal(row.split(",").length, 7)
      }
      assert.match(csv, /^anthropic,claude-sonnet-4-6,2,/m)
    } finally {
      rmrf(dir)
    }
  })
})

describe("runExport period handling", () => {
  it("defaults to 'all' when no period argument is given", () => {
    const { dir, dbPath } = setup()
    try {
      const doc = JSON.parse(exportToFile(dbPath, {})) as { period: string; models: Array<{ model: string }> }
      assert.equal(doc.period, "All Time")
      assert.deepEqual(
        doc.models.map((m) => m.model).sort(),
        ["claude-sonnet-4-6", "gpt-4o"],
      )
    } finally {
      rmrf(dir)
    }
  })

  it("accepts the same periods as stats and filters accordingly", () => {
    const { dir, dbPath } = setup()
    try {
      const today = JSON.parse(exportToFile(dbPath, {}, ["today"])) as { period: string; models: unknown[] }
      assert.equal(today.period, "Today")
      assert.equal(today.models.length, 1) // old gpt-4o event excluded

      const month = JSON.parse(exportToFile(dbPath, {}, ["month"])) as { period: string; models: unknown[] }
      assert.equal(month.period, "Last 30 Days")
      assert.equal(month.models.length, 2)
    } finally {
      rmrf(dir)
    }
  })
})

describe("runExport output target", () => {
  it("writes to stdout when --out is not given", () => {
    const { dir, dbPath } = setup()
    let captured = ""
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((...args: unknown[]) => {
      captured += args.map(String).join("")
      return true
    }) as typeof process.stdout.write
    try {
      runExport({ dbPath, flags: { json: true } })
      assert.ok(captured.startsWith("{"))
      assert.deepEqual(Object.keys(JSON.parse(captured)).sort(), ["daily", "generatedAt", "models", "period"])
    } finally {
      process.stdout.write = original
      rmrf(dir)
    }
  })

  it("writes raw csv to stdout with --csv", () => {
    const { dir, dbPath } = setup()
    let captured = ""
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((...args: unknown[]) => {
      captured += args.map(String).join("")
      return true
    }) as typeof process.stdout.write
    try {
      runExport({ dbPath, flags: { csv: true } })
      assert.ok(captured.startsWith("# daily buckets\n"))
      assert.ok(captured.includes("\n\n# models\n"))
    } finally {
      process.stdout.write = original
      rmrf(dir)
    }
  })
})
