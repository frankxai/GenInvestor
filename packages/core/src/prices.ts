import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Datum, LicenceClass } from "./ledger.ts";

export interface PricePayload {
  ticker: string;
  currency: string;
  basis: "unadjusted";
  epsBasisVerified: boolean;
  licenceUrl: string;
  observations: { date: string; availableAt: string; close: number }[];
  latest: { date: string; availableAt: string; close: number };
}
export interface PriceSource {
  fetchPrice(ticker: string, asOf: string): Promise<Datum>;
}
const calendar = (s: unknown): s is string =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;
const timestamp = (s: unknown): s is string =>
  typeof s === "string" &&
  calendar(s.slice(0, 10)) &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    s,
  ) &&
  Number.isFinite(Date.parse(s));
export function priceDatum(
  raw: unknown,
  ticker: string,
  cutoff: string,
  retrievedAt: string,
): Datum {
  const r = raw as Record<string, any>;
  if (
    !timestamp(cutoff) ||
    !timestamp(retrievedAt) ||
    Date.parse(cutoff) > Date.parse(retrievedAt)
  )
    throw Error("Invalid price cutoff");
  if (
    !r ||
    r.ticker !== ticker ||
    r.currency !== "USD" ||
    r.basis !== "unadjusted"
  )
    throw Error("Ticker, currency or price basis mismatch");
  if (
    !["public", "user_licensed", "sim_only", "restricted"].includes(
      r.licenceClass,
    ) ||
    !/^https:\/\//.test(r.licenceUrl ?? "") ||
    !/^https:\/\//.test(r.sourceUrl ?? "")
  )
    throw Error("Source URL and explicit data rights required");
  if (
    !Array.isArray(r.observations) ||
    !r.observations.length ||
    r.observations.length > 100000
  )
    throw Error("No price observations");
  const dates = new Set<string>();
  for (const o of r.observations) {
    if (
      !o ||
      !calendar(o.date) ||
      !timestamp(o.availableAt) ||
      !Number.isFinite(o.close) ||
      o.close <= 0 ||
      dates.has(o.date) ||
      Date.parse(o.date) > Date.parse(o.availableAt)
    )
      throw Error("Invalid or duplicated price observation");
    dates.add(o.date);
  }
  const observations = r.observations
    .filter((o: any) => Date.parse(o.availableAt) <= Date.parse(cutoff))
    .sort((a: any, b: any) => a.date.localeCompare(b.date));
  const latest = observations.at(-1);
  if (!latest) throw Error("No price was available at the cutoff");
  if ((Date.parse(cutoff) - Date.parse(latest.date)) / 86400000 > 7)
    throw Error("Recorded price is stale for the value screen");
  const payload: PricePayload = {
    ticker,
    currency: "USD",
    basis: "unadjusted",
    epsBasisVerified: r.epsBasisVerified === true,
    licenceUrl: r.licenceUrl,
    observations,
    latest,
  };
  return {
    provider: "recorded-price",
    url: r.sourceUrl,
    asOf: latest.date,
    retrievedAt,
    licenceClass: r.licenceClass as LicenceClass,
    delayedBySeconds: 0,
    payload,
  };
}
export class FilePriceSource implements PriceSource {
  private readonly dir: string;
  private readonly now: () => Date;
  constructor(dir: string, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.now = now;
  }
  async fetchPrice(ticker: string, asOf: string): Promise<Datum> {
    if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) throw Error("Invalid ticker");
    const retrievedAt = this.now().toISOString();
    const requested = asOf.length === 10 ? `${asOf}T23:59:59Z` : asOf;
    const cutoff =
      Date.parse(requested) > Date.parse(retrievedAt) ? retrievedAt : requested;
    return priceDatum(
      JSON.parse(readFileSync(join(this.dir, `${ticker}.json`), "utf8")),
      ticker,
      cutoff,
      retrievedAt,
    );
  }
}
export function annualEarningsMultiple(price: Datum, eps: number): number {
  const p = price.payload as PricePayload;
  if (
    !p.epsBasisVerified ||
    p.basis !== "unadjusted" ||
    !Number.isFinite(eps) ||
    eps <= 0
  )
    throw Error(
      "Positive annual diluted EPS and compatible share basis required",
    );
  const ratio = p.latest.close / eps;
  if (
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    ratio > Number.MAX_SAFE_INTEGER / 100
  )
    throw Error("Unsafe earnings multiple");
  return Math.round(ratio * 100) / 100;
}
