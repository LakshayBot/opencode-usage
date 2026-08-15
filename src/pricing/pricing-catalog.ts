/**
 * Bundled pricing catalog (USD per 1M tokens).
 *
 * Primary source of truth for usage is opencode's own per-step `cost` field
 * (computed with models.dev pricing at time of use). This catalog exists to
 * break that cost into input/output/cache components and to estimate cache
 * savings. Prices here are as of 2026-08; run `opencode-usage update-pricing`
 * to sync fresh data from models.dev into the database.
 *
 * When a provider/model has no entry, the breakdown is reported as "Unknown".
 * Prices are never invented.
 */

import type { CatalogEntry } from "../types/pricing.ts"

const C = 1_000_000 // per million

export const PRICING_CATALOG: Record<string, Record<string, CatalogEntry>> = {
  anthropic: {
    "claude-opus-4-5": { inputPricePerMillion: 5, outputPricePerMillion: 25, cacheReadPricePerMillion: 0.5, cacheWritePricePerMillion: 6.25 },
    "claude-opus-4-1": { inputPricePerMillion: 15, outputPricePerMillion: 75, cacheReadPricePerMillion: 1.5, cacheWritePricePerMillion: 18.75 },
    "claude-opus-4-0": { inputPricePerMillion: 15, outputPricePerMillion: 75, cacheReadPricePerMillion: 1.5, cacheWritePricePerMillion: 18.75 },
    "claude-sonnet-4-6": { inputPricePerMillion: 3, outputPricePerMillion: 15, cacheReadPricePerMillion: 0.3, cacheWritePricePerMillion: 3.75 },
    "claude-sonnet-4-5": { inputPricePerMillion: 3, outputPricePerMillion: 15, cacheReadPricePerMillion: 0.3, cacheWritePricePerMillion: 3.75 },
    "claude-sonnet-4": { inputPricePerMillion: 3, outputPricePerMillion: 15, cacheReadPricePerMillion: 0.3, cacheWritePricePerMillion: 3.75 },
    "claude-3-7-sonnet": { inputPricePerMillion: 3, outputPricePerMillion: 15, cacheReadPricePerMillion: 0.3, cacheWritePricePerMillion: 3.75 },
    "claude-3-5-sonnet": { inputPricePerMillion: 3, outputPricePerMillion: 15, cacheReadPricePerMillion: 0.3, cacheWritePricePerMillion: 3.75 },
    "claude-3-5-haiku": { inputPricePerMillion: 0.8, outputPricePerMillion: 4, cacheReadPricePerMillion: 0.08, cacheWritePricePerMillion: 1 },
    "claude-3-haiku": { inputPricePerMillion: 0.25, outputPricePerMillion: 1.25, cacheReadPricePerMillion: 0.03, cacheWritePricePerMillion: 0.3 },
    "claude-3-opus": { inputPricePerMillion: 15, outputPricePerMillion: 75, cacheReadPricePerMillion: 1.5, cacheWritePricePerMillion: 18.75 },
  },
  openai: {
    "gpt-4o": { inputPricePerMillion: 2.5, outputPricePerMillion: 10 },
    "gpt-4o-mini": { inputPricePerMillion: 0.15, outputPricePerMillion: 0.6 },
    "gpt-4.1": { inputPricePerMillion: 2, outputPricePerMillion: 8 },
    "gpt-4.1-mini": { inputPricePerMillion: 0.4, outputPricePerMillion: 1.6 },
    "gpt-4.1-nano": { inputPricePerMillion: 0.1, outputPricePerMillion: 0.4 },
    "gpt-4-turbo": { inputPricePerMillion: 10, outputPricePerMillion: 30 },
    "gpt-4": { inputPricePerMillion: 30, outputPricePerMillion: 60 },
    "gpt-3.5-turbo": { inputPricePerMillion: 0.5, outputPricePerMillion: 1.5 },
    "o1": { inputPricePerMillion: 15, outputPricePerMillion: 60 },
    "o1-mini": { inputPricePerMillion: 1.1, outputPricePerMillion: 4.4 },
    "o3": { inputPricePerMillion: 2, outputPricePerMillion: 8 },
    "o3-mini": { inputPricePerMillion: 1.1, outputPricePerMillion: 4.4 },
    "o4-mini": { inputPricePerMillion: 1.1, outputPricePerMillion: 4.4 },
  },
  google: {
    "gemini-2.5-pro": { inputPricePerMillion: 1.25, outputPricePerMillion: 10, cacheReadPricePerMillion: 0.06 },
    "gemini-2.5-flash": { inputPricePerMillion: 0.3, outputPricePerMillion: 2.5, cacheReadPricePerMillion: 0.03 },
    "gemini-2.0-flash": { inputPricePerMillion: 0.1, outputPricePerMillion: 0.4, cacheReadPricePerMillion: 0.03 },
    "gemini-1.5-pro": { inputPricePerMillion: 1.25, outputPricePerMillion: 5 },
    "gemini-1.5-flash": { inputPricePerMillion: 0.075, outputPricePerMillion: 0.3 },
  },
  deepseek: {
    "deepseek-chat": { inputPricePerMillion: 0.27, outputPricePerMillion: 1.1, cacheReadPricePerMillion: 0.07 },
    "deepseek-reasoner": { inputPricePerMillion: 0.55, outputPricePerMillion: 2.19, cacheReadPricePerMillion: 0.14 },
  },
  mistral: {
    "mistral-large": { inputPricePerMillion: 2, outputPricePerMillion: 6 },
    "mistral-medium": { inputPricePerMillion: 2.7, outputPricePerMillion: 8.1 },
    "mistral-small": { inputPricePerMillion: 0.2, outputPricePerMillion: 0.6 },
    "codestral": { inputPricePerMillion: 0.3, outputPricePerMillion: 0.9 },
  },
  xai: {
    "grok-4": { inputPricePerMillion: 3, outputPricePerMillion: 15 },
    "grok-3": { inputPricePerMillion: 3, outputPricePerMillion: 15 },
    "grok-2": { inputPricePerMillion: 2, outputPricePerMillion: 10 },
  },
  groq: {
    "llama-3.3-70b": { inputPricePerMillion: 0.59, outputPricePerMillion: 0.79 },
  },
  openrouter: {
    // OpenRouter charges provider price + its own markup per model; the
    // catalog only pins models.dev-listed prices when available. Unknown
    // openrouter models => "Cost: Unknown".
    "anthropic/claude-sonnet-4": { inputPricePerMillion: 3.2, outputPricePerMillion: 15.2, cacheReadPricePerMillion: 0.3 },
    "anthropic/claude-3-5-sonnet": { inputPricePerMillion: 3.2, outputPricePerMillion: 15.2, cacheReadPricePerMillion: 0.3 },
    "openai/gpt-4o": { inputPricePerMillion: 3, outputPricePerMillion: 12 },
  },
}

/** Build a pricing entry from catalog data with a source tag. */
export function catalogEntry(provider: string, model: string): CatalogEntry | undefined {
  const models = PRICING_CATALOG[provider.toLowerCase()]
  if (!models) return undefined
  return models[model.toLowerCase()]
}

/** Resolve a catalog entry with cache prices normalized to null when absent. */
export function catalogPricing(provider: string, model: string): {
  inputPricePerMillion: number | null
  outputPricePerMillion: number | null
  cacheReadPricePerMillion: number | null
  cacheWritePricePerMillion: number | null
} | null {
  const entry = catalogEntry(provider, model)
  if (!entry) return null
  return {
    inputPricePerMillion: entry.inputPricePerMillion ?? null,
    outputPricePerMillion: entry.outputPricePerMillion ?? null,
    cacheReadPricePerMillion: entry.cacheReadPricePerMillion ?? null,
    cacheWritePricePerMillion: entry.cacheWritePricePerMillion ?? null,
  }
}
