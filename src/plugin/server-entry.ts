/**
 * opencode-usage server plugin (loaded from ~/.config/opencode/plugin/).
 *
 * Bundled self-contained; the only runtime imports are `node:sqlite`
 * (provided by opencode's Bun runtime) — no external packages.
 *
 * Hooks:
 *  - `event`       captures usage from every bus event
 *  - `tool.usage`  generates reports for the /usage command (LLM path)
 *  - `dispose`     flushes pending writes
 */

import { resolvePaths } from "../opencode/paths.ts"
import { CatalogPricingProvider } from "../pricing/cost-calculator.ts"
import { HybridPricingProvider } from "../pricing/modelsdev.ts"
import { renderReportMarkdown } from "../reporting/formatters/markdown.ts"
import { computeReport } from "../reporting/usage-report.ts"
import { UsageDatabase } from "../storage/database.ts"
import { UsageTracker } from "../tracker/usage-tracker.ts"
import type { ReportFilter, ReportPeriod } from "../types/usage.ts"

type SdkLog = (input: { body: { service: string; level: string; message: string; extra?: unknown } }) => Promise<unknown>

export default {
  id: "opencode-usage",
  server: async (input: {
    client?: { app?: { log?: SdkLog } }
    project?: { id?: string }
  }) => {
    const paths = resolvePaths()

    const tracker = new UsageTracker({
      dbPath: paths.usageDbPath,
      pricing: new CatalogPricingProvider(),
      log: (level, message, extra) => {
        try {
          void input.client?.app?.log?.({
            body: { service: "opencode-usage", level, message, extra },
          }).catch(() => {})
        } catch {
          // never throw from the logger
        }
      },
    })

    function buildReport(args: { period?: string; model?: string; provider?: string; sessionID?: string }): string {
      let db: UsageDatabase | null = null
      try {
        db = UsageDatabase.open(paths.usageDbPath, { readOnly: true })
        const period = parsePeriod(args.period, args.sessionID)
        const filter: ReportFilter = {}
        if (args.model) filter.model = args.model
        if (args.provider) filter.provider = args.provider
        const pricing = new HybridPricingProvider(db)
        const report = computeReport(db, period, filter, { pricing })
        return renderReportMarkdown(report)
      } catch (error) {
        return [
          "## OpenCode Usage",
          "",
          `Tracking database unavailable: ${String(error)}`,
          "",
          "If this is the first run, ensure the integration is installed:",
          "`opencode-usage install`",
        ].join("\n")
      } finally {
        db?.close()
      }
    }

    return {
      event: async (input: { event: { type: string; properties?: unknown } }) => {
        tracker.handleEvent(input.event)
      },

      tool: {
        usage: {
          description:
            "Generate an OpenCode usage report: tokens, cache statistics, estimated costs. " +
            "Supports period (session|today|week|month|all), model and provider filters.",
          args: {
            period: {
              type: "string",
              description: "session (default) | today | week | month | all",
            },
            model: {
              type: "string",
              description: "Only include this model id (substring match)",
            },
            provider: {
              type: "string",
              description: "Only include this provider (substring match)",
            },
          },
          execute: async (
            args: { period?: string; model?: string; provider?: string },
            ctx: { sessionID: string },
          ) => {
            return buildReport({ ...args, sessionID: ctx.sessionID })
          },
        },
      },

      dispose: async () => {
        tracker.dispose()
      },
    }
  },
}

function parsePeriod(raw: string | undefined, sessionID: string | undefined): ReportPeriod {
  switch (raw ?? "session") {
    case "session":
      return { kind: "session", sessionId: sessionID ?? "current" }
    case "today":
      return { kind: "today" }
    case "week":
      return { kind: "week" }
    case "month":
      return { kind: "month" }
    case "all":
      return { kind: "all" }
    default:
      return { kind: "session", sessionId: sessionID ?? "current" }
  }
}
