import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimsAudit } from "./audit.ts";
import type { Brief, BriefLine } from "./audit.ts";
import { gateNode } from "./graph.ts";
import type { NodeDef, Workflow } from "./graph.ts";
import type { DisplayContext, EvidenceLedger, LinkInput } from "./ledger.ts";
import { getPath } from "./ledger.ts";
import type { PolicyTable } from "./policy.ts";
import type { Provider, SeriesKind, SeriesPayload } from "./providers.ts";

export interface KillCriterion {
  seriesId: string;
  op: "<" | ">";
  threshold: number;
  note?: string;
}

export interface Thesis {
  id: string;
  claim: string;
  killCriteria: KillCriterion[];
  watchMargin?: number; // fraction of the threshold; default 0.05
}

export interface Figure {
  seriesId: string;
  label: string;
  unit: string;
  kind: SeriesKind;
  sourceId: string;
  claimId: string;
  claimText: string;
  latest: { date: string; value: number };
  change: number | null; // percent for level series, percentage points for rate and event series
  ageDays: number | null;
  stale: boolean;
}

export interface ThesisStatus {
  id: string;
  claim: string;
  status: "intact" | "watch" | "broken";
  reasons: string[];
}

export interface Analyst {
  readonly provider: string;
  write(figures: Figure[], statuses: ThesisStatus[]): BriefLine[];
}

export interface Verifier {
  readonly provider: string;
  check(lines: BriefLine[], ledger: EvidenceLedger): { passed: boolean; issues: string[] };
}

export interface TodayContext {
  ledger: EvidenceLedger;
  table: PolicyTable;
  provider: Provider;
  analyst: Analyst;
  verifier: Verifier;
  watchlist: string[];
  theses: Thesis[];
  displayContext: DisplayContext;
  outDir?: string;
  now?: () => Date;
}

export const DISCLOSURE =
  "AI-assisted summary. Information, not advice: no suitability check was performed and nothing here is a recommendation to buy or sell. " +
  "Data may be delayed. Each figure lists its source and as-of date. No scored calls exist yet, so no accuracy figure is shown.";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The recompute functions the claims audit uses to check every "computed" link. */
export const RECOMPUTE: Record<string, (payload: unknown) => number> = {
  pct_change: (payload) => {
    const p = payload as SeriesPayload;
    if (!p.prior) throw new Error("no prior observation");
    return round2((p.latest.value / p.prior.value - 1) * 100);
  },
  pp_change: (payload) => {
    const p = payload as SeriesPayload;
    if (!p.prior) throw new Error("no prior observation");
    return round2(p.latest.value - p.prior.value);
  },
};

/** Days between an observation date (YYYY-MM-DD or YYYY-MM, monthly counted from month end) and now. */
export function ageInDays(now: Date, observed: string): number {
  const monthly = /^(\d{4})-(\d{2})$/.exec(observed);
  const at = monthly ? Date.UTC(Number(monthly[1]), Number(monthly[2]), 0) : Date.parse(observed);
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

export function evaluateThesis(thesis: Thesis, figures: Figure[]): ThesisStatus {
  const reasons: string[] = [];
  let status: ThesisStatus["status"] = "intact";
  const margin = thesis.watchMargin ?? 0.05;
  for (const k of thesis.killCriteria) {
    const fig = figures.find((f) => f.seriesId === k.seriesId);
    if (!fig) {
      status = status === "broken" ? status : "watch";
      reasons.push(`no data for ${k.seriesId}`);
      continue;
    }
    if (fig.stale && status !== "broken") {
      status = "watch";
      reasons.push(`${k.seriesId} data is ${fig.ageDays} days old, so this criterion cannot be checked`);
      continue;
    }
    const v = fig.latest.value;
    const crossed = k.op === "<" ? v < k.threshold : v > k.threshold;
    const near = Math.abs(v - k.threshold) <= Math.abs(k.threshold) * margin;
    if (crossed) {
      status = "broken";
      reasons.push(`${k.seriesId} is ${v}, past the kill line ${k.op} ${k.threshold}${k.note ? ` (${k.note})` : ""}`);
    } else if (near && status !== "broken") {
      status = "watch";
      reasons.push(`${k.seriesId} is ${v}, within ${margin * 100}% of the kill line ${k.op} ${k.threshold}`);
    }
  }
  return { id: thesis.id, claim: thesis.claim, status, reasons };
}

/** Writes one line per figure, using exactly the claim text the ledger already holds. No model involved. */
export class TemplateAnalyst implements Analyst {
  readonly provider = "template";
  write(figures: Figure[]): BriefLine[] {
    return figures.map((f) => ({ text: f.claimText, claimIds: [f.claimId] }));
  }
}

/** Independent rule check: every linked field must still hold the value the line states. */
export class RulesVerifier implements Verifier {
  readonly provider = "rules";
  check(lines: BriefLine[], ledger: EvidenceLedger) {
    const issues: string[] = [];
    lines.forEach((line, i) => {
      for (const id of line.claimIds) {
        const claim = ledger.getClaim(id);
        if (!claim) {
          issues.push(`line ${i}: claim ${id} missing`);
          continue;
        }
        for (const link of claim.links.filter((l) => l.kind === "field")) {
          const src = ledger.getSource(link.sourceId);
          const actual = src ? getPath(src.payload, link.fieldOrQuote) : undefined;
          if (actual === undefined || Number(actual) !== Number(link.value)) issues.push(`line ${i}: ${link.fieldOrQuote} does not match its source`);
        }
      }
    });
    return { passed: issues.length === 0, issues };
  }
}

const withUnit = (value: number, unit: string) => (unit === "%" ? `${value}%` : unit ? `${value} ${unit}` : `${value}`);

/** Wording, change value and evidence links for one series, chosen by its kind so a rate is never shown as a percent of a percent. */
function describe(p: SeriesPayload, sourceId: string): { text: string; change: number | null; links: LinkInput[] } {
  const kind = p.kind ?? "level";
  const links: LinkInput[] = [{ sourceId, kind: "field", fieldOrQuote: "latest.value", value: p.latest.value }];

  if (kind === "event") {
    if (!p.prior) return { text: `${p.label} was ${withUnit(p.latest.value, p.unit)} on ${p.latest.date}`, change: null, links };
    links.push({ sourceId, kind: "field", fieldOrQuote: "prior.value", value: p.prior.value });
    const change = round2(p.latest.value - p.prior.value);
    if (change !== 0) links.push({ sourceId, kind: "computed", fieldOrQuote: "pp_change", value: change });
    return { text: `${p.label} was set to ${withUnit(p.latest.value, p.unit)} on ${p.latest.date}, from ${withUnit(p.prior.value, p.unit)}`, change, links };
  }

  const base = `${p.label} was ${withUnit(p.latest.value, p.unit)} on ${p.latest.date}`;
  if (!p.prior) return { text: base, change: null, links };
  const fn = kind === "rate" ? RECOMPUTE.pp_change : RECOMPUTE.pct_change;
  const change = (fn as (x: unknown) => number)(p);
  if (change === 0) return { text: `${base}, unchanged on the prior observation`, change, links };
  links.push({ sourceId, kind: "computed", fieldOrQuote: kind === "rate" ? "pp_change" : "pct_change", value: change });
  const size = kind === "rate" ? `${Math.abs(change)} percentage points` : `${Math.abs(change)}%`;
  return { text: `${base}, ${change > 0 ? "up" : "down"} ${size} on the prior observation`, change, links };
}

export function todayWorkflow(): Workflow<TodayContext> {
  const fetch: NodeDef<TodayContext> = {
    id: "fetch",
    kind: "fetch",
    deps: [],
    run: async (ctx) => {
      const series = [];
      for (const id of ctx.watchlist) {
        const datum = await ctx.provider.fetchSeries(id);
        const source = ctx.ledger.addSource(datum);
        series.push({ id, sourceId: source.id });
      }
      return { output: { series } };
    },
  };

  const compute: NodeDef<TodayContext> = {
    id: "compute",
    kind: "compute",
    deps: ["fetch"],
    run: (ctx, inputs) => {
      const now = (ctx.now ?? (() => new Date()))();
      const { series } = inputs.fetch as { series: { id: string; sourceId: string }[] };
      const figures: Figure[] = series.map(({ id, sourceId }) => {
        const p = ctx.ledger.getSource(sourceId)?.payload as SeriesPayload;
        const { text, change, links } = describe(p, sourceId);
        const claim = ctx.ledger.addClaim({ text, kind: "fact", producedBy: "compute", runId: `${p.series}@${p.latest.date}`, links });
        const maxAge = p.maxAgeDays ?? null;
        const ageDays = maxAge === null ? null : ageInDays(now, p.latest.date);
        return {
          seriesId: id,
          label: p.label,
          unit: p.unit,
          kind: p.kind ?? "level",
          sourceId,
          claimId: claim.id,
          claimText: text,
          latest: p.latest,
          change,
          ageDays,
          stale: maxAge !== null && ageDays !== null && ageDays > maxAge,
        };
      });
      return { output: { figures } };
    },
  };

  const thesis: NodeDef<TodayContext> = {
    id: "thesis",
    kind: "compute",
    deps: ["compute"],
    run: (ctx, inputs) => {
      const { figures } = inputs.compute as { figures: Figure[] };
      return { output: { statuses: ctx.theses.map((t) => evaluateThesis(t, figures)) } };
    },
  };

  const analyse: NodeDef<TodayContext> = {
    id: "analyse",
    kind: "analyse",
    deps: ["compute", "thesis"],
    run: (ctx, inputs) => {
      const { figures } = inputs.compute as { figures: Figure[] };
      const { statuses } = inputs.thesis as { statuses: ThesisStatus[] };
      return { output: { lines: ctx.analyst.write(figures, statuses) } };
    },
  };

  const verify: NodeDef<TodayContext> = {
    id: "verify",
    kind: "verify",
    deps: ["analyse"],
    run: (ctx, inputs) => {
      if (ctx.verifier.provider === ctx.analyst.provider) return { block: `verifier (${ctx.verifier.provider}) must differ from the writer` };
      const { lines } = inputs.analyse as { lines: BriefLine[] };
      const result = ctx.verifier.check(lines, ctx.ledger);
      return result.passed ? { output: { verifiedBy: ctx.verifier.provider } } : { block: `verifier rejected: ${result.issues.join("; ")}` };
    },
  };

  const audit: NodeDef<TodayContext> = {
    id: "audit",
    kind: "audit",
    deps: ["analyse"],
    run: (ctx, inputs) => {
      const { lines } = inputs.analyse as { lines: BriefLine[] };
      const brief: Brief = { title: "Today", generatedAt: "", lines };
      const result = claimsAudit(brief, ctx.ledger, { context: ctx.displayContext, recompute: RECOMPUTE });
      return result.passed
        ? { output: { passed: true } }
        : { block: `claims audit failed: ${result.findings.map((f) => `${f.code} (line ${f.line})`).join(", ")}` };
    },
  };

  const human: NodeDef<TodayContext> = {
    id: "human",
    kind: "human",
    deps: ["thesis"],
    run: (_ctx, inputs) => {
      const { statuses } = inputs.thesis as { statuses: ThesisStatus[] };
      const broken = statuses.filter((s) => s.status === "broken");
      if (broken.length === 0) return { output: { needed: false } };
      return { waiting: { approver: "owner", reason: `thesis marked broken by rule: ${broken.map((b) => b.id).join(", ")}` } };
    },
  };

  const gate = gateNode<TodayContext>("gate", ["audit", "verify"], (ctx) => ctx.table, { action_type: "artifact_write" });

  const publish: NodeDef<TodayContext> = {
    id: "publish",
    kind: "publish",
    deps: ["analyse", "compute", "thesis", "audit", "verify", "human", "gate"],
    run: (ctx, inputs) => {
      const { lines } = inputs.analyse as { lines: BriefLine[] };
      const { figures } = inputs.compute as { figures: Figure[] };
      const { statuses } = inputs.thesis as { statuses: ThesisStatus[] };
      const chip = (line: BriefLine) => {
        const fig = figures.find((f) => f.claimId === line.claimIds[0]);
        const src = fig ? ctx.ledger.getSource(fig.sourceId) : undefined;
        if (!src || !fig) return "";
        const stale = fig.stale ? ` ⚠ stale, ${fig.ageDays} days old` : "";
        return ` _(${src.provider}, as of ${src.asOf}, retrieved ${src.retrievedAt.slice(0, 16)}Z${stale})_`;
      };
      const stale = figures.filter((f) => f.stale);
      const date = figures.map((f) => f.latest.date).sort().at(-1) ?? "n/a";
      const markdown = [
        `# Today, ${date}`,
        "",
        ...lines.map((l) => `- ${l.text}${chip(l)}`),
        "",
        ...(stale.length ? ["## Data quality", ...stale.map((f) => `- ${f.label}: latest observation is ${f.ageDays} days old, past its expected cadence. Treat it as out of date.`), ""] : []),
        "## Thesis status",
        ...(statuses.length ? statuses.map((s) => `- ${s.id}: **${s.status}**${s.reasons.length ? `. ${s.reasons.join("; ")}` : ""}`) : ["- none tracked"]),
        "",
        "---",
        DISCLOSURE,
        "",
      ].join("\n");
      const json = { date, lines, statuses, stale: stale.map((f) => f.seriesId), sources: figures.map((f) => f.sourceId), disclosure: DISCLOSURE };
      if (ctx.outDir) {
        mkdirSync(ctx.outDir, { recursive: true });
        writeFileSync(join(ctx.outDir, "brief.md"), markdown, "utf8");
        writeFileSync(join(ctx.outDir, "brief.json"), JSON.stringify(json, null, 2), "utf8");
      }
      return { output: { markdown, json } };
    },
  };

  return { id: "today", version: "2", nodes: [fetch, compute, thesis, analyse, verify, audit, human, gate, publish] };
}
