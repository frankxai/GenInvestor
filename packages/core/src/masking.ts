import { createHmac } from "node:crypto";

/**
 * Masking for anything a language model will read. Design after TraderHarness (Apache-2.0),
 * "contamination is an environment boundary, not a promise in a prompt":
 *  - companies and tickers become stable pseudonyms (a bijection per seed);
 *  - absolute dates become offsets from "today" (D-243, Y-1);
 *  - numbers are left alone, because the analysis needs them.
 * An auditor scans any artifact for what should have been masked.
 *
 * Limit, stated plainly: masking removes names and dates. It cannot stop a model from recognising a
 * company by distinctive products, executives or financial fingerprints. Compare masked and unmasked
 * runs whenever that matters.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RX = `(?:${MONTHS.join("|")}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\.?`;

export interface Entity {
  ticker: string;
  name?: string;
  aliases?: string[]; // other names the entity appears under
}

export interface Leak {
  kind: "ticker" | "name" | "date" | "year";
  match: string;
  index: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
const signed = (prefix: string, n: number) => `${prefix}${n >= 0 ? "+" : "-"}${Math.abs(n)}`;

const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const ISO_MONTH = /(?<![\d-])(\d{4})-(\d{2})(?![\d-])/g;
const WRITTEN_MDY = new RegExp(`\\b(${MONTH_RX})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
const WRITTEN_DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RX}),?\\s+(\\d{4})\\b`, "gi");
const MONTH_YEAR = new RegExp(`\\b(${MONTH_RX})\\s+(\\d{4})\\b`, "gi");
// A year that stands alone. A trailing full stop ends a sentence; a full stop or comma followed by a digit is a decimal or thousands separator.
const BARE_YEAR = /(?<![\d,.$-])((?:19|20)\d{2})(?!\d|[.,]\d|-\d)/g;

const monthIndex = (m: string) => {
  const k = m.toLowerCase().replace(".", "").slice(0, 3);
  return MONTHS.findIndex((x) => x.startsWith(k));
};
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export class Masker {
  private readonly seed: string;
  readonly today: string;
  private readonly byTicker = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();
  private readonly names: { text: string; alias: string }[] = [];

  constructor(opts: { seed: string; today: string }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) throw new Error("today must be YYYY-MM-DD");
    if (!opts.seed) throw new Error("a masking seed is required: without one the pseudonyms would be guessable");
    this.seed = opts.seed;
    this.today = opts.today;
  }

  /** Stable pseudonym for a ticker: same seed and ticker always give the same alias, and no two tickers share one. */
  register(entity: Entity): { ticker: string; name: string } {
    const existing = this.byTicker.get(entity.ticker);
    let suffix = existing?.replace("ASSET-", "");
    if (!suffix) {
      const digest = createHmac("sha256", this.seed).update(entity.ticker).digest("hex").toUpperCase();
      for (let len = 4; len <= digest.length; len++) {
        const candidate = digest.slice(0, len);
        if (!this.byAlias.has(`ASSET-${candidate}`)) {
          suffix = candidate;
          break;
        }
      }
      this.byTicker.set(entity.ticker, `ASSET-${suffix}`);
      this.byAlias.set(`ASSET-${suffix}`, entity.ticker);
    }
    const nameAlias = `Company ${suffix}`;
    for (const n of [entity.name, ...(entity.aliases ?? [])]) {
      if (n && n.length >= 3 && !this.names.some((x) => x.text.toLowerCase() === n.toLowerCase())) this.names.push({ text: n, alias: nameAlias });
    }
    this.names.sort((a, b) => b.text.length - a.text.length); // longest first, so "ACME HOLDINGS INC" wins over "ACME"
    return { ticker: `ASSET-${suffix}`, name: nameAlias };
  }

  aliasFor(ticker: string): string | undefined {
    return this.byTicker.get(ticker);
  }

  /** "D-243" for a date 243 days before today; "D+0" for today. */
  maskDate(isoDate: string): string {
    return signed("D", daysBetween(isoDate, this.today));
  }

  private maskYear(year: number): string {
    return signed("Y", year - Number(this.today.slice(0, 4)));
  }

  /** Whole months before or after the current month: "M-8". */
  private maskMonth(year: number, monthIdx: number): string {
    return signed("M", year * 12 + monthIdx - (Number(this.today.slice(0, 4)) * 12 + Number(this.today.slice(5, 7)) - 1));
  }

  private tickerPattern(ticker: string): RegExp {
    // One and two letter tickers ("A", "F", "GE") are also words and initials: only when written as $A or (A).
    if (ticker.length < 3) return new RegExp(`(?:\\$${escape(ticker)}(?![A-Za-z0-9])|\\(${escape(ticker)}\\))`, "g");
    return new RegExp(`(?<![A-Za-z0-9$])\\$?${escape(ticker)}(?![A-Za-z0-9])`, "g");
  }

  maskText(text: string): string {
    let out = text;
    for (const n of this.names) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escape(n.text)}(?![A-Za-z0-9])`, "gi"), n.alias);
    for (const [ticker, alias] of this.byTicker) {
      out = out.replace(this.tickerPattern(ticker), (m) => (m.startsWith("(") ? `(${alias})` : alias));
    }
    out = out.replace(ISO_DATE, (_m, y, mo, d) => this.maskDate(iso(Number(y), Number(mo) - 1, Number(d))));
    out = out.replace(WRITTEN_MDY, (_m, mo, d, y) => this.maskDate(iso(Number(y), monthIndex(mo), Number(d))));
    out = out.replace(WRITTEN_DMY, (_m, d, mo, y) => this.maskDate(iso(Number(y), monthIndex(mo), Number(d))));
    out = out.replace(MONTH_YEAR, (_m, mo, y) => this.maskMonth(Number(y), monthIndex(mo)));
    out = out.replace(ISO_MONTH, (_m, y, mo) => this.maskMonth(Number(y), Number(mo) - 1));
    out = out.replace(BARE_YEAR, (_m, y) => this.maskYear(Number(y)));
    return out;
  }

  /** Mask every string in a structure (keys and numbers are untouched). */
  maskDeep<T>(value: T): T {
    if (typeof value === "string") return this.maskText(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.maskDeep(v)) as unknown as T;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.maskDeep(v)])) as unknown as T;
    }
    return value;
  }

  /** Owner-side reverse: pseudonyms back to names and tickers, and offsets back to dates. */
  unmask(text: string): string {
    let out = text;
    for (const [alias, ticker] of this.byAlias) {
      const suffix = alias.replace("ASSET-", "");
      const name = this.names.find((n) => n.alias === `Company ${suffix}`)?.text;
      out = out.replace(new RegExp(escape(alias), "g"), ticker);
      if (name) out = out.replace(new RegExp(`Company ${suffix}(?![A-Z0-9])`, "g"), name);
    }
    out = out.replace(/(?<![A-Za-z])M([+-])(\d+)/g, (_m, s, n) => {
      const total = Number(this.today.slice(0, 4)) * 12 + Number(this.today.slice(5, 7)) - 1 + (s === "-" ? -1 : 1) * Number(n);
      return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
    });
    out = out.replace(/(?<![A-Za-z])D([+-])(\d+)/g, (_m, s, n) => new Date(Date.parse(`${this.today}T00:00:00Z`) + (s === "-" ? -1 : 1) * Number(n) * DAY).toISOString().slice(0, 10));
    out = out.replace(/(?<![A-Za-z])Y([+-])(\d+)/g, (_m, s, n) => String(Number(this.today.slice(0, 4)) + (s === "-" ? -1 : 1) * Number(n)));
    return out;
  }

  /** Everything in an artifact that should have been masked. A clean masked artifact returns []. */
  audit(text: string): Leak[] {
    const leaks: Leak[] = [];
    for (const n of this.names) for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${escape(n.text)}(?![A-Za-z0-9])`, "gi"))) leaks.push({ kind: "name", match: m[0], index: m.index as number });
    for (const ticker of this.byTicker.keys()) for (const m of text.matchAll(this.tickerPattern(ticker))) leaks.push({ kind: "ticker", match: m[0], index: m.index as number });
    for (const rx of [ISO_DATE, WRITTEN_MDY, WRITTEN_DMY, MONTH_YEAR, ISO_MONTH]) for (const m of text.matchAll(new RegExp(rx.source, rx.flags))) leaks.push({ kind: "date", match: m[0], index: m.index as number });
    for (const m of text.matchAll(new RegExp(BARE_YEAR.source, BARE_YEAR.flags))) leaks.push({ kind: "year", match: m[0], index: m.index as number });
    return leaks.sort((a, b) => a.index - b.index);
  }
}
