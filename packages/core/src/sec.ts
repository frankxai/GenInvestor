import type { Datum } from "./ledger.ts";
import type { FetchLike } from "./providers.ts";

export interface FactPoint {
  end: string;
  val: number;
  filed: string;
  form: string;
  fy?: number;
  start?: string;
  accn?: string;
}

/** The subset of an SEC company-facts response that we use, kept as the evidence payload. */
export interface SecPayload {
  cik: string;
  ticker: string;
  name: string;
  revenueTag: string;
  revenue: FactPoint[]; // annual, newest first, one per fiscal year end (latest filing wins)
  operatingIncome: FactPoint[];
  netIncome: FactPoint[];
  liabilities: FactPoint[]; // balance-sheet dates
  equity: FactPoint[];
  /** Present when the payload was built point-in-time: nothing filed after this date is in it. */
  knownAsOf?: string;
}

export interface Metrics {
  fiscalYearEnd: string;
  filedAt: string;
  revenue: number;
  priorRevenue: number;
  revenueGrowthPct: number;
  operatingMarginPct: number | null;
  liabilitiesToEquity: number | null;
  negativeEquity: boolean;
}

export type Extraction = { ok: true; payload: SecPayload } | { ok: false; reason: string };

interface RawFact {
  start?: string;
  end: string;
  val: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form: string;
  filed: string;
}
type RawFacts = { cik?: number | string; entityName?: string; facts?: { "us-gaap"?: Record<string, { units?: { USD?: RawFact[] } }> } };

const REVENUE_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"];
const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

function usd(raw: RawFacts, tag: string): RawFact[] {
  return raw.facts?.["us-gaap"]?.[tag]?.units?.USD ?? [];
}

/** One point per fiscal year end. The same year is repeated in later filings; the most recent filing wins. */
function dedupe(points: RawFact[]): FactPoint[] {
  const byEnd = new Map<string, RawFact>();
  for (const p of points) {
    const cur = byEnd.get(p.end);
    if (!cur || p.filed > cur.filed) byEnd.set(p.end, p);
  }
  return [...byEnd.values()]
    .sort((a, b) => (a.end < b.end ? 1 : -1))
    .slice(0, 3)
    .map((p) => ({ end: p.end, val: p.val, filed: p.filed, form: p.form, fy: p.fy, start: p.start, accn: p.accn }));
}

/** Full-year flows: annual reports only, and only entries that really span a year (10-Ks also carry quarters). */
function annualFlow(raw: RawFact[]): FactPoint[] {
  return dedupe(raw.filter((x) => /^10-K/.test(x.form) && x.start && days(x.start, x.end) >= 330 && days(x.start, x.end) <= 400));
}

function annualBalance(raw: RawFact[]): FactPoint[] {
  return dedupe(raw.filter((x) => /^10-K/.test(x.form) && !x.start));
}

export interface ExtractOptions {
  /**
   * Point-in-time cutoff (YYYY-MM-DD). Only facts filed on or before this date are used, and where a
   * fiscal year was later restated, the version that was public on that date wins. Without it, a
   * historical screen would quietly use information nobody had yet.
   */
  asOf?: string;
}

export function extractPayload(raw: unknown, ticker: string, options: ExtractOptions = {}): Extraction {
  const r = raw as RawFacts;
  if (!r?.facts?.["us-gaap"]) return { ok: false, reason: "no US-GAAP data (foreign filer, or a company that does not report XBRL financials)" };
  const known = (rows: RawFact[]) => (options.asOf ? rows.filter((x) => x.filed <= (options.asOf as string)) : rows);
  let revenueTag = "";
  let revenue: FactPoint[] = [];
  for (const tag of REVENUE_TAGS) {
    const pts = annualFlow(known(usd(r, tag)));
    if (pts.length >= 2) {
      revenueTag = tag;
      revenue = pts;
      break;
    }
  }
  if (revenue.length < 2) {
    return { ok: false, reason: options.asOf ? `fewer than two annual revenue figures had been filed by ${options.asOf}` : "fewer than two annual revenue figures in 10-K filings" };
  }
  return {
    ok: true,
    payload: {
      cik: String(r.cik ?? "").padStart(10, "0"),
      ticker,
      name: r.entityName ?? ticker,
      revenueTag,
      revenue,
      operatingIncome: annualFlow(known(usd(r, "OperatingIncomeLoss"))),
      netIncome: annualFlow(known(usd(r, "NetIncomeLoss"))),
      liabilities: annualBalance(known(usd(r, "Liabilities"))),
      equity: annualBalance(known(usd(r, "StockholdersEquity"))),
      ...(options.asOf ? { knownAsOf: options.asOf } : {}),
    },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const at = (pts: FactPoint[], end: string) => pts.find((p) => p.end === end);

export function metricsOf(p: SecPayload): Metrics {
  const [latest, prior] = p.revenue as [FactPoint, FactPoint];
  const op = at(p.operatingIncome, latest.end);
  const liab = at(p.liabilities, latest.end);
  const eq = at(p.equity, latest.end);
  return {
    fiscalYearEnd: latest.end,
    filedAt: latest.filed,
    revenue: latest.val,
    priorRevenue: prior.val,
    revenueGrowthPct: round2((latest.val / prior.val - 1) * 100),
    operatingMarginPct: op ? round2((op.val / latest.val) * 100) : null,
    liabilitiesToEquity: liab && eq && eq.val > 0 ? round2(liab.val / eq.val) : null,
    negativeEquity: Boolean(eq && eq.val <= 0),
  };
}

/** The functions the claims audit uses to re-derive every figure from the stored payload. */
export const SEC_RECOMPUTE: Record<string, (payload: unknown) => number> = {
  revenue_growth_pct: (p) => {
    const m = metricsOf(p as SecPayload);
    return m.revenueGrowthPct;
  },
  operating_margin_pct: (p) => {
    const m = metricsOf(p as SecPayload);
    if (m.operatingMarginPct === null) throw new Error("no operating income for the latest fiscal year");
    return m.operatingMarginPct;
  },
  liabilities_to_equity: (p) => {
    const m = metricsOf(p as SecPayload);
    if (m.liabilitiesToEquity === null) throw new Error("no usable balance sheet for the latest fiscal year");
    return m.liabilitiesToEquity;
  },
  operating_margin_prior_pct: (p) => {
    const s = p as SecPayload;
    const rev = s.revenue[1];
    const op = rev && at(s.operatingIncome, rev.end);
    if (!rev || !op) throw new Error("no operating income for the prior fiscal year");
    return round2((op.val / rev.val) * 100);
  },
  operating_margin_change_pp: (p) => {
    const s = p as SecPayload;
    const latest = SEC_RECOMPUTE.operating_margin_pct?.(s) as number;
    const prior = SEC_RECOMPUTE.operating_margin_prior_pct?.(s) as number;
    return round2(latest - prior);
  },
  revenue_growth_prior_pct: (p) => {
    const s = p as SecPayload;
    const [, a, b] = s.revenue;
    if (!a || !b) throw new Error("fewer than three annual revenue figures");
    return round2((a.val / b.val - 1) * 100);
  },
};

export interface SecOptions {
  identity: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  minIntervalMs?: number;
}

/** Fetches fundamentals from SEC EDGAR. The SEC requires a contact identity and limits request rates. */
export class SecProvider {
  readonly name = "sec-edgar";
  private readonly identity: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly minIntervalMs: number;
  private last = 0;
  private tickers?: Map<string, string>;

  constructor(opts: SecOptions) {
    if (!/\S+@\S+\.\S+/.test(opts.identity ?? "")) {
      throw new Error('The SEC requires a contact identity on every request. Set GENINVESTOR_SEC_IDENTITY to "Your Name your@email".');
    }
    this.identity = opts.identity;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => new Date());
    this.minIntervalMs = opts.minIntervalMs ?? 150; // well under the SEC's ten requests a second
  }

  private async get(url: string): Promise<unknown> {
    const wait = this.last + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last = Date.now();
    const res = await this.fetchImpl(url, { headers: { "User-Agent": this.identity, Accept: "application/json" } });
    if (res.status === 403 || res.status === 429) {
      throw new Error(`SEC refused the request (HTTP ${res.status}). Check GENINVESTOR_SEC_IDENTITY and slow down.`);
    }
    if (res.status === 404) throw new Error(`SEC has no data at ${url}`);
    if (!res.ok) throw new Error(`SEC returned HTTP ${res.status} for ${url}`);
    return res.json();
  }

  async cikFor(ticker: string, hint?: string): Promise<string> {
    if (hint) return hint.padStart(10, "0");
    if (!this.tickers) {
      const raw = (await this.get("https://www.sec.gov/files/company_tickers.json")) as Record<string, { cik_str: number; ticker: string }>;
      this.tickers = new Map(Object.values(raw).map((c) => [c.ticker.toUpperCase(), String(c.cik_str).padStart(10, "0")]));
    }
    const cik = this.tickers.get(ticker.toUpperCase());
    if (!cik) throw new Error(`${ticker} is not in the SEC ticker list`);
    return cik;
  }

  /** Returns a Datum, or a reason the company cannot be screened. */
  async fetchFundamentals(ticker: string, cikHint?: string, asOf?: string): Promise<{ ok: true; datum: Datum } | { ok: false; reason: string }> {
    const cik = await this.cikFor(ticker, cikHint);
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const extraction = extractPayload(await this.get(url), ticker, { asOf });
    if (!extraction.ok) return extraction;
    const m = metricsOf(extraction.payload);
    return {
      ok: true,
      datum: {
        provider: this.name,
        url,
        asOf: m.fiscalYearEnd,
        retrievedAt: this.now().toISOString(),
        licenceClass: "public",
        delayedBySeconds: 0,
        payload: extraction.payload,
      },
    };
  }
}
