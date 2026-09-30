import { readFileSync } from "node:fs";
import { validate } from "../../contracts/src/validate.ts";
import type { Schema } from "../../contracts/src/validate.ts";
import { loadSchema } from "./contracts.ts";
import { canonicalJson, sha256 } from "./ledger.ts";

export interface Mandate {
  version: 1;
  name: string;
  markets: string[];
  horizonYears: number;
  riskTolerance: "low" | "medium" | "high";
  styles: ("quality" | "growth" | "value" | "special-situation")[];
  exclusions?: { tickers?: string[]; keywords?: string[] };
  limits?: { maxPositionPct?: number; maxSectorPct?: number };
  thresholds?: { minRevenueGrowthPct?: number; minOperatingMarginPct?: number; maxLiabilitiesToEquity?: number };
  watchlist: { ticker: string; cik?: string }[];
  holdings?: string[];
}

export interface MandateCheck {
  valid: boolean;
  errors: string[];
  warnings: string[];
  mandate?: Mandate;
}

/** Defaults used when the owner does not set a threshold. Stated in every screen record. */
export const DEFAULT_THRESHOLDS = { minRevenueGrowthPct: 10, minOperatingMarginPct: 15, maxLiabilitiesToEquity: 3 };

export const EXAMPLE_MANDATE: Mandate = {
  version: 1,
  name: "My mandate",
  markets: ["us-equities"],
  horizonYears: 10,
  riskTolerance: "medium",
  styles: ["quality"],
  exclusions: { tickers: [], keywords: [] },
  limits: { maxPositionPct: 5, maxSectorPct: 25 },
  thresholds: { minRevenueGrowthPct: 8, minOperatingMarginPct: 20, maxLiabilitiesToEquity: 3 },
  watchlist: [{ ticker: "MSFT" }, { ticker: "AAPL" }],
  holdings: [],
};

/** Schema validation plus the rules a schema cannot express. */
export function checkMandate(input: unknown): MandateCheck {
  const errors = validate(loadSchema("mandate") as Schema, input);
  const warnings: string[] = [];
  if (errors.length > 0) return { valid: false, errors, warnings };

  const m = input as Mandate;
  const tickers = m.watchlist.map((w) => w.ticker);
  const dupes = tickers.filter((t, i) => tickers.indexOf(t) !== i);
  if (dupes.length > 0) errors.push(`watchlist has duplicate tickers: ${[...new Set(dupes)].join(", ")}`);
  const excluded = new Set(m.exclusions?.tickers ?? []);
  const clash = tickers.filter((t) => excluded.has(t));
  if (clash.length > 0) errors.push(`watchlist contains excluded tickers: ${clash.join(", ")}`);
  if (m.limits?.maxPositionPct !== undefined && m.limits.maxSectorPct !== undefined && m.limits.maxPositionPct > m.limits.maxSectorPct) {
    errors.push("limits.maxPositionPct cannot exceed limits.maxSectorPct");
  }
  if (m.styles.includes("value")) warnings.push("style 'value' needs price data, which is not available yet: it will be skipped and said so in the screen record");
  if (m.styles.includes("special-situation")) warnings.push("style 'special-situation' is not implemented yet: it will be skipped and said so in the screen record");
  if (m.markets.some((x) => x !== "us-equities")) warnings.push("only 'us-equities' has a fundamentals source today (SEC filings); other markets will be skipped");
  return { valid: errors.length === 0, errors, warnings, mandate: errors.length === 0 ? m : undefined };
}

export function loadMandate(path: string): MandateCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { valid: false, errors: [`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`], warnings: [] };
  }
  return checkMandate(raw);
}

export function effectiveThresholds(m: Mandate) {
  return { ...DEFAULT_THRESHOLDS, ...(m.thresholds ?? {}) };
}

/**
 * A fingerprint that lets a card say which rules produced it without revealing them. It covers the
 * name, styles and thresholds. Holdings, exclusions and the watchlist are deliberately left out.
 */
export function mandateFingerprint(m: Mandate): string {
  return sha256(canonicalJson({ name: m.name, styles: [...m.styles].sort(), thresholds: effectiveThresholds(m) })).slice(0, 12);
}
