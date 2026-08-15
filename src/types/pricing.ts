/**
 * Pricing types. Pricing lives behind a provider interface so the catalog
 * can be swapped (bundled catalog, models.dev sync, future remote pricing).
 */

/** Prices in USD per 1,000,000 tokens. */
export interface ModelPricing {
  inputPricePerMillion: number | null
  outputPricePerMillion: number | null
  cacheReadPricePerMillion: number | null
  cacheWritePricePerMillion: number | null
  /** Unix ms when this pricing became effective. */
  effectiveFrom: number
  /** Unix ms when this pricing stopped being effective (null = still effective). */
  effectiveUntil: number | null
  /** Where the price came from: "catalog" | "models.dev" | "user". */
  source: string
}

/** A catalog entry keyed by provider + model id. Missing cache fields mean "not priced". */
export interface CatalogEntry {
  inputPricePerMillion: number | null
  outputPricePerMillion: number | null
  cacheReadPricePerMillion?: number | null
  cacheWritePricePerMillion?: number | null
}

export interface PricingProvider {
  /**
   * Resolve the best matching pricing for a provider/model at a point in
   * time. Returns null when no pricing is known — never invented.
   */
  getPricing(provider: string, model: string, timestamp: number): ModelPricing | null
}

/** Raw models.dev shape (https://models.dev/api.json). */
export interface ModelsDevEntry {
  id: string
  name?: string
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
}

export interface ModelsDevProvider {
  id: string
  name?: string
  models?: Record<string, ModelsDevEntry>
}

export interface ModelsDevApi {
  [providerId: string]: ModelsDevProvider
}
