import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimsAudit } from "./audit.ts";
import type { BriefLine } from "./audit.ts";
import { gateNode } from "./graph.ts";
import type { NodeDef, Workflow } from "./graph.ts";
import type { DisplayContext, EvidenceLedger, LinkInput } from "./ledger.ts";
import { DEFAULT_THRESHOLDS, effectiveThresholds, mandateFingerprint } from "./mandate.ts";
import type { Mandate } from "./mandate.ts";
import type { PolicyTable } from "./policy.ts";
import { metricsOf, SEC_RECOMPUTE } from "./sec.ts";
import type { Metrics, SecPayload } from "./sec.ts";
import type { Datum } from "./ledger.ts";
import { DISCLOSURE } from "./today.ts";
import { annualEarningsMultiple } from "./prices.ts";
import type { PriceSource, PricePayload } from "./prices.ts";

export const MAX_CARDS = 5;

export interface Criterion {
  id: "revenue_growth" | "operating_margin" | "leverage" | "revenue_not_shrinking" | "profitable";
  label: string;
  value: number | null;
  threshold: number;
  passed: boolean;
  headroom: number; // 0 to 1, how far past the line
}

export interface Card {
  ticker: string;
  name: string;
  mandate: string; // fingerprint of the rules that produced it
  asOf: string;
  filedAt: string;
  style: "quality" | "growth" | "value";
  score: number;
  whyPassed: BriefLine[];
  wouldProveWrong: BriefLine[];
  caseAgainst: BriefLine[];
  risks: string[];
  checkNext: string[];
  suggestedCall: { claim: string; resolvesOn: string; resolutionSource: string; note: string };
  sourceId: string;
  scoreClaimId?: string;
}

export interface ScreenRecord {
  mandate: string;
  stylesRun: string[];
  stylesUnavailable: { style: string; reason: string }[];
  thresholds: typeof DEFAULT_THRESHOLDS;
  thresholdsFromDefaults: string[];
  universe: number;
  screened: number;
  passed: number;
  skippedHeld: number;
  skippedExcluded: number;
  noData: { ticker: string; reason: string }[];
  ranAt: string;
  claimIds?: string[];
}

export interface FundamentalsSource {
  fetchFundamentals(ticker: string, cik?: string, asOf?: string): Promise<{ ok: true; datum: Datum } | { ok: false; reason: string }>;
}

export interface CardWriter {
  readonly provider: string;
}
export interface Skeptic {
  readonly provider: string;
  argue(input: { ledger: EvidenceLedger; card: Card; payload: SecPayload; metrics: Metrics; thresholds: typeof DEFAULT_THRESHOLDS; sec: string; mandateSource: string }): BriefLine[];
}
export interface ScoutVerifier {
  readonly provider: string;
  check(lines: BriefLine[], ledger: EvidenceLedger): { passed: boolean; issues: string[] };
}

export interface ScoutContext {
  ledger: EvidenceLedger;
  table: PolicyTable;
  mandate: Mandate;
  sec: FundamentalsSource;
  writer: CardWriter;
  skeptic: Skeptic;
  verifier: ScoutVerifier;
  displayContext: DisplayContext;
  outDir?: string;
  now?: () => Date;
  /** Run the screen as it would have run on this date (YYYY-MM-DD): only filings public by then are used. */
  asOf?: string;
  prices?: PriceSource;
}

/** Extra recompute functions the skeptic needs; registered alongside the SEC ones. */
export const SCOUT_RECOMPUTE: Record<string, (payload: unknown) => number> = {
  ...SEC_RECOMPUTE,
  annual_earnings_multiple: (raw) => { const p = raw as { price: number; eps: number }; return Math.round(p.price / p.eps * 100) / 100; },
};

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const usd = (n: number) => `${fmt(n)} USD`;

function criteriaFor(style: "quality" | "growth", m: Metrics, t: typeof DEFAULT_THRESHOLDS): Criterion[] {
  const headroomUp = (v: number, th: number) => Math.max(0, Math.min(1, (v - th) / Math.max(Math.abs(th), 1)));
  const headroomDown = (v: number, th: number) => Math.max(0, Math.min(1, (th - v) / Math.max(Math.abs(th), 1)));
  const out: Criterion[] = [];
  if (style === "quality") {
    out.push({ id: "operating_margin", label: "operating margin", value: m.operatingMarginPct, threshold: t.minOperatingMarginPct, passed: m.operatingMarginPct !== null && m.operatingMarginPct >= t.minOperatingMarginPct, headroom: m.operatingMarginPct === null ? 0 : headroomUp(m.operatingMarginPct, t.minOperatingMarginPct) });
    out.push({ id: "leverage", label: "liabilities to equity", value: m.liabilitiesToEquity, threshold: t.maxLiabilitiesToEquity, passed: m.liabilitiesToEquity !== null && m.liabilitiesToEquity <= t.maxLiabilitiesToEquity, headroom: m.liabilitiesToEquity === null ? 0 : headroomDown(m.liabilitiesToEquity, t.maxLiabilitiesToEquity) });
    out.push({ id: "revenue_not_shrinking", label: "revenue growth", value: m.revenueGrowthPct, threshold: 0, passed: m.revenueGrowthPct >= 0, headroom: headroomUp(m.revenueGrowthPct, 0) });
  } else {
    out.push({ id: "revenue_growth", label: "revenue growth", value: m.revenueGrowthPct, threshold: t.minRevenueGrowthPct, passed: m.revenueGrowthPct >= t.minRevenueGrowthPct, headroom: headroomUp(m.revenueGrowthPct, t.minRevenueGrowthPct) });
    out.push({ id: "profitable", label: "operating margin", value: m.operatingMarginPct, threshold: 0, passed: m.operatingMarginPct !== null && m.operatingMarginPct > 0, headroom: m.operatingMarginPct === null ? 0 : headroomUp(m.operatingMarginPct, 0) });
  }
  return out;
}

const scoreOf = (cs: Criterion[]) => Math.round((cs.reduce((a, c) => a + c.headroom, 0) / cs.length) * 1000) / 1000;

function addOneYear(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The first annual report that has not been filed yet, and a date by which it should be public
 * (fiscal year end plus 90 days, the outer limit of the SEC filing deadlines). Rolls forward when the
 * latest filing is old, so the suggested call is always in the future and can be registered.
 */
export function nextReportWindow(fiscalYearEnd: string, now: Date): { nextEnd: string; resolvesOn: string } {
  const today = now.toISOString().slice(0, 10);
  let nextEnd = addOneYear(fiscalYearEnd);
  let resolvesOn = addDays(nextEnd, 90);
  while (resolvesOn <= today) {
    nextEnd = addOneYear(nextEnd);
    resolvesOn = addDays(nextEnd, 90);
  }
  return { nextEnd, resolvesOn };
}

/** Claims for one candidate. Every figure on a card comes from one of these, and each is audited. */
function candidateClaims(ledger: EvidenceLedger, payload: SecPayload, m: Metrics, sec: string, mandateSource: string, t: typeof DEFAULT_THRESHOLDS) {
  const runId = `${payload.ticker}@${m.fiscalYearEnd}`;
  const link = (sourceId: string, kind: LinkInput["kind"], fieldOrQuote: string, value: number | string): LinkInput => ({ sourceId, kind, fieldOrQuote, value });
  const mk = (text: string, links: LinkInput[]) => ledger.addClaim({ text, kind: "fact", producedBy: "scout", runId, links: text.startsWith(payload.name) ? [...links, link(sec, "field", "name", payload.name)] : links });

  const growth = mk(
    `${payload.name} reported revenue of ${usd(m.revenue)} for the fiscal year ended ${m.fiscalYearEnd}, ${m.revenueGrowthPct >= 0 ? "up" : "down"} ${Math.abs(m.revenueGrowthPct)}% from ${usd(m.priorRevenue)} the year before`,
    [link(sec, "field", "revenue.0.val", m.revenue), link(sec, "field", "revenue.1.val", m.priorRevenue), link(sec, "computed", "revenue_growth_pct", m.revenueGrowthPct)],
  );
  const margin = m.operatingMarginPct === null ? undefined : mk(`${payload.name} operating margin was ${m.operatingMarginPct}% in the fiscal year ended ${m.fiscalYearEnd}`, [link(sec, "computed", "operating_margin_pct", m.operatingMarginPct)]);
  const leverage = m.liabilitiesToEquity === null ? undefined : mk(`${payload.name} total liabilities were ${m.liabilitiesToEquity} times shareholders' equity at ${m.fiscalYearEnd}`, [link(sec, "computed", "liabilities_to_equity", m.liabilitiesToEquity)]);
  const thresholds = mk(
    `Your mandate asks for revenue growth of at least ${t.minRevenueGrowthPct}%, operating margin of at least ${t.minOperatingMarginPct}% and liabilities of at most ${t.maxLiabilitiesToEquity} times equity`,
    [link(mandateSource, "field", "thresholds.minRevenueGrowthPct", t.minRevenueGrowthPct), link(mandateSource, "field", "thresholds.minOperatingMarginPct", t.minOperatingMarginPct), link(mandateSource, "field", "thresholds.maxLiabilitiesToEquity", t.maxLiabilitiesToEquity)],
  );
  const filed = mk(`The latest annual report was filed on ${m.filedAt}`, [link(sec, "field", "revenue.0.filed", m.filedAt)]);
  return { growth, margin, leverage, thresholds, filed };
}

export function screenRecordOf(ctx: ScoutContext, extra: Partial<ScreenRecord>): ScreenRecord {
  const m = ctx.mandate;
  const own = m.thresholds ?? {};
  const styles = m.styles;
  return {
    mandate: mandateFingerprint(m),
    stylesRun: styles.filter((s) => s === "quality" || s === "growth" || (s === "value" && ctx.prices && m.thresholds?.maxAnnualEarningsMultiple)),
    stylesUnavailable: [
      ...(styles.includes("value") && (!ctx.prices || !m.thresholds?.maxAnnualEarningsMultiple) ? [{ style: "value", reason: "needs price data from a recorded source and an owner-defined maxAnnualEarningsMultiple" }] : []),
      ...(styles.includes("special-situation") ? [{ style: "special-situation", reason: "not implemented yet" }] : []),
    ],
    thresholds: effectiveThresholds(m),
    thresholdsFromDefaults: (Object.keys(DEFAULT_THRESHOLDS) as (keyof typeof DEFAULT_THRESHOLDS)[]).filter((k) => own[k] === undefined),
    universe: m.watchlist.length,
    screened: 0,
    passed: 0,
    skippedHeld: 0,
    skippedExcluded: 0,
    noData: [],
    ranAt: (ctx.now ?? (() => new Date()))().toISOString(),
    ...extra,
  };
}

interface FetchOutput {
  fetched: { ticker: string; sourceId: string; priceSourceId?: string }[];
  skippedHeld: number;
  skippedExcluded: number;
  noData: { ticker: string; reason: string }[];
  mandateSourceId: string;
}
interface ComputeOutput {
  candidates: { card: Card; payload: SecPayload; metrics: Metrics }[];
  screen: ScreenRecord;
  mandateSourceId: string;
}

export function scoutWorkflow(): Workflow<ScoutContext> {
  const fetch: NodeDef<ScoutContext> = {
    id: "fetch",
    kind: "fetch",
    deps: [],
    run: async (ctx) => {
      const m = ctx.mandate;
      const now = (ctx.now ?? (() => new Date()))();
      // The mandate is evidence too: claims about your rules link to it. It carries no holdings, watchlist or exclusions.
      const mandateSource = ctx.ledger.addSource({
        provider: "mandate",
        url: `local://mandate/${mandateFingerprint(m)}`,
        asOf: now.toISOString().slice(0, 10),
        retrievedAt: now.toISOString(),
        licenceClass: "user_licensed",
        delayedBySeconds: 0,
        payload: { styles: [...m.styles].sort(), thresholds: effectiveThresholds(m) },
      });
      const held = new Set(m.holdings ?? []);
      const excludedTickers = new Set(m.exclusions?.tickers ?? []);
      const keywords = (m.exclusions?.keywords ?? []).map((k) => k.toLowerCase());
      const out: FetchOutput = { fetched: [], skippedHeld: 0, skippedExcluded: 0, noData: [], mandateSourceId: mandateSource.id };

      if (!m.markets.includes("us-equities")) {
        out.noData.push({ ticker: "(all)", reason: "the mandate has no market with a fundamentals source: only us-equities is supported" });
        return { output: out };
      }
      for (const w of m.watchlist) {
        if (held.has(w.ticker)) { out.skippedHeld++; continue; }
        if (excludedTickers.has(w.ticker)) { out.skippedExcluded++; continue; }
        try {
          const r = await ctx.sec.fetchFundamentals(w.ticker, w.cik, ctx.asOf);
          if (!r.ok) { out.noData.push({ ticker: w.ticker, reason: r.reason }); continue; }
          const name = (r.datum.payload as SecPayload).name.toLowerCase();
          if (keywords.some((k) => name.includes(k))) { out.skippedExcluded++; continue; }
          const source = ctx.ledger.addSource(r.datum);
          let priceSourceId: string | undefined;
          if (ctx.prices && m.styles.includes("value")) {
            try { priceSourceId = ctx.ledger.addSource(await ctx.prices.fetchPrice(w.ticker, ctx.asOf ?? now.toISOString())).id; }
            catch { out.noData.push({ ticker: w.ticker, reason: "value style has no usable, fresh recorded price" }); }
          }
          out.fetched.push({ ticker: w.ticker, sourceId: source.id, priceSourceId });
        } catch (error) {
          out.noData.push({ ticker: w.ticker, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return { output: out };
    },
  };

  const compute: NodeDef<ScoutContext> = {
    id: "compute",
    kind: "compute",
    deps: ["fetch"],
    run: (ctx, inputs) => {
      const f = inputs.fetch as FetchOutput;
      const t = effectiveThresholds(ctx.mandate);
      const styles = ctx.mandate.styles.filter((s): s is "quality" | "growth" | "value" => s === "quality" || s === "growth" || (s === "value" && Boolean(ctx.prices) && Boolean(ctx.mandate.thresholds?.maxAnnualEarningsMultiple)));
      const found: ComputeOutput["candidates"] = [];

      for (const { ticker, sourceId, priceSourceId } of f.fetched) {
        const payload = ctx.ledger.getSource(sourceId)?.payload as SecPayload;
        const metrics = metricsOf(payload);
        for (const style of styles) {
          let valueLine: BriefLine | undefined;
          let multiple: number | undefined;
          const ceiling = ctx.mandate.thresholds?.maxAnnualEarningsMultiple;
          if (style === "value") {
            const eps = payload.dilutedEps?.find((p) => p.end === metrics.fiscalYearEnd);
            const price = priceSourceId ? ctx.ledger.getSource(priceSourceId) : undefined;
            if (!eps || !price || !ceiling) continue;
            try { multiple = annualEarningsMultiple(price, eps.val); } catch { continue; }
            if (multiple > ceiling) continue;
            const input = ctx.ledger.addSource({ ...price, provider: "value-basis", url: `local://value/${sourceId}/${priceSourceId}`, payload: { price: (price.payload as PricePayload).latest.close, eps: eps.val, secSourceId: sourceId, priceSourceId } });
            const epsIndex = payload.dilutedEps!.indexOf(eps);
            const text = `Annual earnings multiple was ${multiple}, using recorded price ${(price.payload as PricePayload).latest.close} USD and annual diluted EPS ${eps.val} USD per share`;
            const claim = ctx.ledger.addClaim({ text, kind: "fact", producedBy: "value-screen", runId: `${ticker}@${price.asOf}`, links: [
              { sourceId: input.id, kind: "computed", fieldOrQuote: "annual_earnings_multiple", value: multiple },
              { sourceId: price.id, kind: "field", fieldOrQuote: "latest.close", value: (price.payload as PricePayload).latest.close },
              { sourceId, kind: "field", fieldOrQuote: `dilutedEps.${epsIndex}.val`, value: eps.val },
            ] });
            valueLine = { text, claimIds: [claim.id] };
          }
          const criteria = criteriaFor(style === "value" ? "quality" : style, metrics, t);
          if (style === "value") criteria.splice(0, criteria.length);
          if (!criteria.every((c) => c.passed)) continue;
          const claims = candidateClaims(ctx.ledger, payload, metrics, sourceId, f.mandateSourceId, t);
          const passedLines: BriefLine[] =
            style === "quality"
              ? [claims.margin, claims.leverage, claims.growth].filter((c) => c !== undefined).map((c) => ({ text: c.text, claimIds: [c.id] }))
              : [claims.growth, claims.margin].filter((c) => c !== undefined).map((c) => ({ text: c.text, claimIds: [c.id] }));
          passedLines.push({ text: claims.thresholds.text, claimIds: [claims.thresholds.id] });
          if (valueLine) passedLines.push(valueLine);

          const proveWrong = criteria
            .filter((c) => c.id !== "revenue_not_shrinking" && c.id !== "profitable")
            .map((c): BriefLine => ({
              text: c.id === "operating_margin"
                ? `This case is wrong if operating margin falls below ${t.minOperatingMarginPct}% in a later annual report`
                : c.id === "leverage"
                  ? `This case is wrong if total liabilities rise above ${t.maxLiabilitiesToEquity} times equity in a later annual report`
                  : `This case is wrong if revenue growth falls below ${t.minRevenueGrowthPct}% in a later annual report`,
              claimIds: [claims.thresholds.id],
            }));
          if (style === "quality") proveWrong.push({ text: "This case is also wrong if revenue starts to shrink year on year", claimIds: [] });
          if (style === "growth") proveWrong.push({ text: "This case is also wrong if the company stops being profitable at the operating level", claimIds: [] });
          if (style === "value") proveWrong.push({ text: "Recheck when earnings, share basis or the recorded price changes; this annual ratio is not a valuation conclusion", claimIds: [] });

          const { nextEnd, resolvesOn } = nextReportWindow(metrics.fiscalYearEnd, (ctx.now ?? (() => new Date()))());
          const checkedMeasure = style === "quality" ? `operating margin at or above ${t.minOperatingMarginPct}%` : `revenue growth at or above ${t.minRevenueGrowthPct}%`;
          const card: Card = {
            ticker,
            name: payload.name,
            mandate: mandateFingerprint(ctx.mandate),
            asOf: metrics.fiscalYearEnd,
            filedAt: metrics.filedAt,
            style,
            score: style === "value" ? Math.round((1 - multiple! / ceiling!) * 1000) / 1000 : scoreOf(criteria),
            whyPassed: [...passedLines, { text: claims.filed.text, claimIds: [claims.filed.id] }],
            wouldProveWrong: proveWrong,
            caseAgainst: [],
            risks: [
              style === "value" ? "Annual earnings multiple uses recorded prices and annual diluted EPS; it is not a target or a valuation conclusion." : "Price and valuation are not part of this screen. A strong business can still be an expensive one.",
              "It reads annual reports only, so anything that changed since the latest one is not reflected.",
              ...(metrics.negativeEquity ? ["Shareholders' equity is negative, so leverage cannot be read from it."] : []),
            ],
            checkNext: [
              "Read the risk factors and the segment note in the latest annual report.",
              "Check how revenue is recognised and whether any large item is one-off.",
              "Compare the same three measures with two direct competitors.",
            ],
            suggestedCall: {
              claim: `${ticker}: ${checkedMeasure} in the annual report for the fiscal year ending ${nextEnd}`,
              resolvesOn,
              resolutionSource: `Form 10-K for the fiscal year ending ${nextEnd}, on SEC EDGAR`,
              note: "A research criterion only; no forecast is registered.",
            },
            sourceId,
          };
          found.push({ card, payload, metrics });
          break; // one card per company, under the first style it passes
        }
      }
      found.sort((a, b) => b.card.score - a.card.score || (a.card.ticker < b.card.ticker ? -1 : 1));
      const top = found.slice(0, MAX_CARDS);
      const screen = screenRecordOf(ctx, {
        screened: f.fetched.length,
        passed: found.length,
        skippedHeld: f.skippedHeld,
        skippedExcluded: f.skippedExcluded,
        noData: f.noData,
      });
      const stats = ctx.ledger.addSource({ provider: "screen-record", url: `local://screen/${screen.mandate}/${screen.ranAt}`, asOf: screen.ranAt.slice(0, 10), retrievedAt: screen.ranAt, licenceClass: "user_licensed", delayedBySeconds: 0, payload: { ...screen, scores: top.map((x) => x.card.score), inputSourceIds: f.fetched.map((x) => x.sourceId) } });
      screen.claimIds = ["universe", "screened", "passed", "skippedHeld", "skippedExcluded"].map((key) => {
        const value = screen[key as keyof ScreenRecord] as number;
        const label = { universe: "Companies in universe", screened: "Companies screened", passed: "Candidates passed", skippedHeld: "Already held", skippedExcluded: "Excluded by your rules" }[key]!;
        return ctx.ledger.addClaim({ text: `${label}: ${value}`, kind: "fact", producedBy: "screen-record", runId: screen.ranAt, links: [{ sourceId: stats.id, kind: "field", fieldOrQuote: key, value }] }).id;
      });
      top.forEach((x, i) => { x.card.scoreClaimId = ctx.ledger.addClaim({ text: `Rule fit score ${x.card.score}`, kind: "fact", producedBy: "screen-record", runId: screen.ranAt, links: [{ sourceId: stats.id, kind: "field", fieldOrQuote: `scores.${i}`, value: x.card.score }] }).id; });
      return { output: { candidates: top, screen, mandateSourceId: f.mandateSourceId } satisfies ComputeOutput };
    },
  };

  const skeptic: NodeDef<ScoutContext> = {
    id: "skeptic",
    kind: "analyse",
    deps: ["compute"],
    run: (ctx, inputs) => {
      const c = inputs.compute as ComputeOutput;
      if (ctx.skeptic.provider === ctx.writer.provider) return { block: `the skeptic (${ctx.skeptic.provider}) must differ from the writer` };
      const t = effectiveThresholds(ctx.mandate);
      const cards = c.candidates.map(({ card, payload, metrics }) => ({
        ...card,
        caseAgainst: ctx.skeptic.argue({ ledger: ctx.ledger, card, payload, metrics, thresholds: t, sec: card.sourceId, mandateSource: c.mandateSourceId }),
      }));
      return { output: { cards, screen: c.screen } };
    },
  };

  const allLines = (cards: Card[], screen: ScreenRecord, ledger: EvidenceLedger) => [
    ...cards.flatMap((c) => [...c.whyPassed, ...c.wouldProveWrong, ...c.caseAgainst]),
    ...[...(screen.claimIds ?? []), ...cards.flatMap((c) => c.scoreClaimId ? [c.scoreClaimId] : [])].map((id) => ({ text: ledger.getClaim(id)?.text ?? "Missing run record", claimIds: [id] })),
  ];

  const verify: NodeDef<ScoutContext> = {
    id: "verify",
    kind: "verify",
    deps: ["skeptic"],
    run: (ctx, inputs) => {
      const { cards, screen } = inputs.skeptic as { cards: Card[]; screen: ScreenRecord };
      if (ctx.verifier.provider === ctx.writer.provider || ctx.verifier.provider === ctx.skeptic.provider) {
        return { block: `the verifier (${ctx.verifier.provider}) must differ from the writer and the skeptic` };
      }
      const r = ctx.verifier.check(allLines(cards, screen, ctx.ledger), ctx.ledger);
      return r.passed ? { output: { verifiedBy: ctx.verifier.provider } } : { block: `verifier rejected: ${r.issues.join("; ")}` };
    },
  };

  const audit: NodeDef<ScoutContext> = {
    id: "audit",
    kind: "audit",
    deps: ["skeptic"],
    run: (ctx, inputs) => {
      const { cards, screen } = inputs.skeptic as { cards: Card[]; screen: ScreenRecord };
      const result = claimsAudit({ title: "Opportunities", generatedAt: "", lines: allLines(cards, screen, ctx.ledger) }, ctx.ledger, { context: ctx.displayContext, recompute: SCOUT_RECOMPUTE });
      return result.passed ? { output: { passed: true } } : { block: `claims audit failed: ${result.findings.map((f) => `${f.code} (${f.detail.slice(0, 80)})`).join("; ")}` };
    },
  };

  const gate = gateNode<ScoutContext>("gate", ["audit", "verify"], (ctx) => ctx.table, { action_type: "artifact_write" });

  const publish: NodeDef<ScoutContext> = {
    id: "publish",
    kind: "publish",
    deps: ["skeptic", "audit", "verify", "gate"],
    run: (ctx, inputs) => {
      const { cards, screen } = inputs.skeptic as { cards: Card[]; screen: ScreenRecord };
      const date = screen.ranAt.slice(0, 10);
      const list = (lines: BriefLine[]) => lines.map((l) => `- ${l.text}${l.claimIds.map((id) => ` [claim:${id}]`).join("")}`).join("\n");
      const md = [
        `# Opportunities, ${date}`,
        "",
        "Candidates for research, not recommendations. Zero is a valid result. Every figure below links to a claim in the local ledger.",
        ...(screen.claimIds ?? []).map((id) => `- ${ctx.ledger.getClaim(id)!.text} [claim:${id}]`),
        "",
        ...cards.flatMap((c) => [
          `## ${c.name} (${c.ticker})`,
          `_${c.style} screen · latest annual report for the year ended ${c.asOf} · sec-edgar_`,
          "",
          "**Why it passed**",
          list(c.whyPassed),
          "",
          "**What would prove it wrong**",
          list(c.wouldProveWrong),
          "",
          "**The case against**",
          list(c.caseAgainst),
          "",
          "**Risks**",
          c.risks.map((r) => `- ${r}`).join("\n"),
          "",
          "**Check next**",
          c.checkNext.map((r) => `- ${r}`).join("\n"),
          "",
          "**Research criterion**",
          "- Recheck the linked mandate criterion against the next primary filing; no forecast is registered.",
          "",
        ]),
        "## Screen record",
        `- Rules fingerprint ${screen.mandate}; styles run: ${screen.stylesRun.join(", ") || "none"}.`,
        ...screen.stylesUnavailable.map((s) => `- Style ${s.style} was skipped: ${s.reason}.`),
        "- Thresholds are linked to your mandate in each card; the screen is a research filter.",
        "- Skipped and missing data are recorded above; unavailable inputs are never inferred.",
        ...screen.noData.map((n) => `  - ${n.ticker}: ${n.reason}`),
        "",
        "## Not visible to this screen",
        "Accounting quality, management, legal exposure and competition. Price requires explicitly compatible recorded data.",
        "",
        "---",
        DISCLOSURE,
        "",
      ].join("\n");
      const json = { date, screen, cards, disclosure: DISCLOSURE };
      if (ctx.outDir) {
        mkdirSync(ctx.outDir, { recursive: true });
        writeFileSync(join(ctx.outDir, "opportunities.md"), md, "utf8");
        writeFileSync(join(ctx.outDir, "opportunities.json"), JSON.stringify(json, null, 2), "utf8");
      }
      return { output: { markdown: md, json } };
    },
  };

  return { id: "scout", version: "2", nodes: [fetch, compute, skeptic, verify, audit, gate, publish] };
}

/** The default skeptic: counter-evidence drawn from the same filings, never from a model. */
export class RulesSkeptic implements Skeptic {
  readonly provider = "rules-skeptic";
  argue({ ledger, card, payload, metrics, thresholds, sec, mandateSource }: Parameters<Skeptic["argue"]>[0]): BriefLine[] {
    const lines: BriefLine[] = [];
    const runId = `${card.ticker}@${card.asOf}:skeptic`;
    const mk = (text: string, links: LinkInput[]) => {
      const c = ledger.addClaim({ text, kind: "inference", producedBy: this.provider, runId, links });
      lines.push({ text, claimIds: [c.id] });
    };
    const comp = (sourceId: string, field: string, value: number): LinkInput => ({ sourceId, kind: "computed", fieldOrQuote: field, value });

    // Every figure here comes from the same recompute functions the audit uses, so they cannot disagree.
    const derive = (name: string): number | undefined => {
      try {
        return SEC_RECOMPUTE[name]?.(payload);
      } catch {
        return undefined; // the data for that measure is not there
      }
    };
    // Margin trend.
    const priorMargin = derive("operating_margin_prior_pct");
    const change = derive("operating_margin_change_pp");
    if (metrics.operatingMarginPct !== null && priorMargin !== undefined && change !== undefined && change < 0) {
      mk(`Operating margin moved from ${priorMargin}% a year earlier to ${metrics.operatingMarginPct}%, a change of ${change} percentage points`, [
        comp(sec, "operating_margin_pct", metrics.operatingMarginPct),
        comp(sec, "operating_margin_prior_pct", priorMargin),
        comp(sec, "operating_margin_change_pp", change),
      ]);
    }
    // Growth trend.
    const priorGrowth = derive("revenue_growth_prior_pct");
    if (priorGrowth !== undefined && metrics.revenueGrowthPct < priorGrowth) {
      mk(`Revenue growth was ${metrics.revenueGrowthPct}% against ${priorGrowth}% the year before`, [comp(sec, "revenue_growth_pct", metrics.revenueGrowthPct), comp(sec, "revenue_growth_prior_pct", priorGrowth)]);
    }
    // Leverage close to the ceiling.
    if (metrics.liabilitiesToEquity !== null && metrics.liabilitiesToEquity >= thresholds.maxLiabilitiesToEquity * 0.8) {
      mk(`Total liabilities were ${metrics.liabilitiesToEquity} times equity against your ceiling of ${thresholds.maxLiabilitiesToEquity}`, [
        comp(sec, "liabilities_to_equity", metrics.liabilitiesToEquity),
        { sourceId: mandateSource, kind: "field", fieldOrQuote: "thresholds.maxLiabilitiesToEquity", value: thresholds.maxLiabilitiesToEquity },
      ]);
    }
    if (lines.length === 0) lines.push({ text: "No adverse trend was found in the three measures this screen reads. That is a limit of the screen, not a finding about the business.", claimIds: [] });
    lines.push({ text: "A screen on annual filings cannot see accounting quality, management, legal exposure, competition or a complete valuation. Assume the strongest argument against this company is one it cannot see.", claimIds: [] });
    return lines;
  }
}
