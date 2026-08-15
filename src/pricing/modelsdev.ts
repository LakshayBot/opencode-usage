/**
 * Sync pricing data from models.dev (https://models.dev/api.json) — the same
 * source opencode itself uses for per-step cost — into pricing_history rows
 * with `effective_from` = sync time. Used by `opencode-usage update-pricing`.
 */

import type { ModelsDevApi, ModelsDevEntry } from "../types/pricing.ts"
import { UsageDatabase } from "../storage/database.ts"

export const MODELS_DEV_URL = "https://models.dev/api.json"

export interface SyncResult {
  fetchedAt: number
  providers: number
  models: number
  imported: number
  skipped: number
  source: string
}

export async function fetchModelsDev(fetchFn: typeof fetch = fetch): Promise<ModelsDevApi> {
  const response = await fetchFn(MODELS_DEV_URL)
  if (!response.ok) {
    throw new Error(`models.dev returned ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as ModelsDevApi
  return data
}

export function extractEntries(data: ModelsDevApi): Array<{
  provider: string
  model: string
  cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}> {
  const entries: Array<{
    provider: string
    model: string
    cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  }> = []
  for (const [providerId, provider] of Object.entries(data)) {
    if (!provider || !provider.models) continue
    for (const [modelId, model] of Object.entries(provider.models)) {
      const cost = model?.cost
      if (!cost) continue
      entries.push({
        provider: providerId,
        model: modelId,
        cost: {
          input: cost.input,
          output: cost.output,
          cacheRead: cost.cache_read,
          cacheWrite: cost.cache_write,
        },
      })
    }
  }
  return entries
}

/** Store a batch of pricing rows (effective now). Only first-seen (provider, model) pairs are stored. */
export function importPricingRows(db: UsageDatabase, entries: ReturnType<typeof extractEntries>, now: number): number {
  const insert = db.raw.prepare(`
    INSERT OR IGNORE INTO pricing_history (
      provider, model,
      input_per_million, output_per_million,
      cache_read_per_million, cache_write_per_million,
      effective_from, effective_until, source
    ) SELECT ?, ?, ?, ?, ?, ?, ?, NULL, 'models.dev'
      WHERE NOT EXISTS (
        SELECT 1 FROM pricing_history WHERE provider = ? AND model = ?
      )
  `)
  let imported = 0
  db.runInTransaction((tx) => {
    for (const entry of entries) {
      const result = insert.run(
        entry.provider,
        entry.model,
        entry.cost.input ?? null,
        entry.cost.output ?? null,
        entry.cost.cacheRead ?? null,
        entry.cost.cacheWrite ?? null,
        now,
        entry.provider,
        entry.model,
      )
      if (result.changes > 0) imported++
    }
  })
  return imported
}

export async function syncPricingFromModelsDev(db: UsageDatabase, fetchFn: typeof fetch = fetch): Promise<SyncResult> {
  const fetchedAt = Date.now()
  const data = await fetchModelsDev(fetchFn)
  const entries = extractEntries(data)
  const imported = importPricingRows(db, entries, fetchedAt)
  return {
    fetchedAt,
    providers: Object.keys(data).length,
    models: entries.length,
    imported,
    skipped: entries.length - imported,
    source: "models.dev",
  }
}

/**
 * PricingProvider that consults models.dev-synced rows in the database first,
 * falling back to the bundled catalog. Historical queries use the pricing row
 * effective at the event's timestamp.
 */
import { CatalogPricingProvider } from "./cost-calculator.ts"
import type { ModelPricing, PricingProvider } from "../types/pricing.ts"

export class HybridPricingProvider implements PricingProvider {
  private db: UsageDatabase | null
  private fallback: PricingProvider

  constructor(db: UsageDatabase | null, fallback: PricingProvider = new CatalogPricingProvider()) {
    this.db = db
    this.fallback = fallback
  }

  setDb(db: UsageDatabase | null): void {
    this.db = db
  }

  getPricing(provider: string, model: string, timestamp: number): ModelPricing | null {
    const row = this.db?.raw
      .prepare(
        `SELECT input_per_million, output_per_million, cache_read_per_million, cache_write_per_million,
                effective_from, effective_until, source
         FROM pricing_history
         WHERE provider = ? AND model = ? AND effective_from <= ?
         ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(provider, model, timestamp) as
      | {
          input_per_million: number | null
          output_per_million: number | null
          cache_read_per_million: number | null
          cache_write_per_million: number | null
          effective_from: number
          effective_until: number | null
          source: string
        }
      | undefined

    if (row) {
      if (row.effective_until !== null && timestamp > row.effective_until) {
        // Fall through: row no longer effective at this time.
      } else {
        return {
          inputPricePerMillion: row.input_per_million,
          outputPricePerMillion: row.output_per_million,
          cacheReadPricePerMillion: row.cache_read_per_million,
          cacheWritePricePerMillion: row.cache_write_per_million,
          effectiveFrom: row.effective_from,
          effectiveUntil: row.effective_until,
          source: row.source,
        }
      }
    }
    return this.fallback.getPricing(provider, model, timestamp)
  }
}
