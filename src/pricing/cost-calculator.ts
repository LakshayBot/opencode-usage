/**
 * Cost calculator.
 *
 * Formulas (per the project spec, matching opencode's own model):
 *
 *   inputCost    = inputTokens / 1M * inputPricePerMillion
 *   outputCost   = (outputTokens + reasoningTokens) / 1M * outputPricePerMillion
 *                 (reasoning tokens are charged at the output rate, matching
 *                  opencode's documented behavior)
 *   cacheReadCost  = cacheReadTokens / 1M * cacheReadPricePerMillion
 *   cacheWriteCost = cacheWriteTokens / 1M * cacheWritePricePerMillion
 *   total          = sum of the above (null when any component price is unknown)
 *
 * Everything produced here is an ESTIMATE derived from public pricing.
 * The authoritative "cost at time of use" is opencode's own `cost` field.
 */

import type { ModelPricing, PricingProvider } from "../types/pricing.ts"
import type { UsageEvent } from "../types/usage.ts"
import { catalogPricing } from "./pricing-catalog.ts"

export interface CostComponents {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  total: number | null
  unknown: boolean
}

export class CostCalculator {
  /**
   * Compute component costs for an event given a resolved pricing.
   * Missing prices yield null components and null total (never invented).
   */
  static forEvent(event: UsageEvent, pricing: ModelPricing | null): CostComponents {
    return CostCalculator.compute(
      {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens + event.reasoningTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
      },
      pricing,
    )
  }

  static compute(
    tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
    pricing: ModelPricing | null,
  ): CostComponents {
    if (!pricing) {
      return { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, unknown: true }
    }
    const input = CostCalculator.mul(tokens.inputTokens, pricing.inputPricePerMillion)
    const output = CostCalculator.mul(tokens.outputTokens, pricing.outputPricePerMillion)
    const cacheRead = CostCalculator.mul(tokens.cacheReadTokens, pricing.cacheReadPricePerMillion)
    const cacheWrite = CostCalculator.mul(tokens.cacheWriteTokens, pricing.cacheWritePricePerMillion)

    const parts = [input, output, cacheRead, cacheWrite]
    const unknown = parts.some((part) => part === null)
    let total: number | null = 0
    if (!unknown) {
      for (const part of parts) {
        total += part ?? 0
      }
    } else {
      total = null
    }

    return { input, output, cacheRead, cacheWrite, total, unknown }
  }

  private static mul(tokens: number, pricePerMillion: number | null): number | null {
    if (pricePerMillion === null || pricePerMillion === undefined || !Number.isFinite(pricePerMillion)) return null
    return (tokens / 1_000_000) * pricePerMillion
  }
}

/**
 * Default PricingProvider backed by the bundled catalog. Exact-match lookup
 * with provider/model normalization (lowercase, common prefixes stripped).
 */
export class CatalogPricingProvider implements PricingProvider {
  getPricing(provider: string, model: string, timestamp: number): ModelPricing | null {
    const entry = catalogPricing(provider, model)
    if (!entry) return null
    return {
      inputPricePerMillion: entry.inputPricePerMillion,
      outputPricePerMillion: entry.outputPricePerMillion,
      cacheReadPricePerMillion: entry.cacheReadPricePerMillion,
      cacheWritePricePerMillion: entry.cacheWritePricePerMillion,
      effectiveFrom: 0,
      effectiveUntil: null,
      source: "catalog",
    }
  }
}
