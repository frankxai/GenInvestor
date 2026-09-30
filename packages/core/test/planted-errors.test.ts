// A planted-error corpus for the claims audit and the rules verifier.
// Real cards and briefs are generated, then mutated in every way a careless or dishonest writer could:
// wrong numbers, tampered evidence, misattributed sources, fabricated quotes, missing citations.
// The measured catch rate is gated: it must be 100%, and unmutated output must raise no findings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsAudit, numbersIn } from "../src/audit.ts";
import type { BriefLine } from "../src/audit.ts";
import { loadPolicyTable } from "../src/contracts.ts";
import { runWorkflow, WorkflowStore } from "../src/graph.ts";
import { EvidenceLedger } from "../src/ledger.ts";
import { EXAMPLE_MANDATE } from "../src/mandate.ts";
import { FixtureProvider } from "../src/providers.ts";
import { RulesSkeptic, SCOUT_RECOMPUTE, scoutWorkflow } from "../src/scout.ts";
import type { Card, ScoutContext } from "../src/scout.ts";
import { extractPayload, metricsOf } from "../src/sec.ts";
import { RECOMPUTE, RulesVerifier, TemplateAnalyst, todayWorkflow } from "../src/today.ts";
import type { SeriesPayload } from "../src/providers.ts";

/** Everything the audit may be asked to re-derive: the daily brief's figures and the scout's. */
const ALL_RECOMPUTE = { ...RECOMPUTE, ...SCOUT_RECOMPUTE };

const table = loadPolicyTable();

function raw(cik: number, name: string, years: { year: number; rev: number; op: number; liab: number; eq: number }[]) {
  const flow = (k: "rev" | "op") => years.map((y) => ({ start: `${y.year}-01-01`, end: `${y.year}-12-31`, val: y[k], form: "10-K", fp: "FY", filed: `${y.year + 1}-02-15` }));
  const inst = (k: "liab" | "eq") => years.map((y) => ({ end: `${y.year}-12-31`, val: y[k], form: "10-K", fp: "FY", filed: `${y.year + 1}-02-15` }));
  return { cik, entityName: name, facts: { "us-gaap": { Revenues: { units: { USD: flow("rev") } }, OperatingIncomeLoss: { units: { USD: flow("op") } }, Liabilities: { units: { USD: inst("liab") } }, StockholdersEquity: { units: { USD: inst("eq") } } } } };
}
const DATA: Record<string, unknown> = {
  STRONG: raw(11, "STRONGCO INC", [
    { year: 2025, rev: 1_100_000_000, op: 275_000_000, liab: 600_000_000, eq: 400_000_000 },
    { year: 2024, rev: 1_000_000_000, op: 300_000_000, liab: 550_000_000, eq: 400_000_000 },
    { year: 2023, rev: 900_000_000, op: 260_000_000, liab: 500_000_000, eq: 380_000_000 },
  ]),
  STEADY: raw(12, "STEADYCO INC", [
    { year: 2025, rev: 1_200_000_000, op: 360_000_000, liab: 300_000_000, eq: 600_000_000 },
    { year: 2024, rev: 1_000_000_000, op: 280_000_000, liab: 300_000_000, eq: 550_000_000 },
    { year: 2023, rev: 850_000_000, op: 220_000_000, liab: 300_000_000, eq: 500_000_000 },
  ]),
};

async function build() {
  const ledger = new EvidenceLedger();
  const ctx: ScoutContext = {
    ledger, table,
    mandate: { ...EXAMPLE_MANDATE, thresholds: { minRevenueGrowthPct: 8, minOperatingMarginPct: 20, maxLiabilitiesToEquity: 3 }, watchlist: [{ ticker: "STRONG" }, { ticker: "STEADY" }] },
    sec: { fetchFundamentals: async (ticker: string) => {
      const e = extractPayload(DATA[ticker], ticker);
      if (!e.ok) return e;
      return { ok: true as const, datum: { provider: "sec-edgar", url: `fixture://${ticker}`, asOf: metricsOf(e.payload).fiscalYearEnd, retrievedAt: "2026-09-30T06:00:00.000Z", licenceClass: "public" as const, delayedBySeconds: 0, payload: e.payload } };
    } },
    writer: { provider: "template-writer" }, skeptic: new RulesSkeptic(), verifier: new RulesVerifier(SCOUT_RECOMPUTE),
    displayContext: "local_user", now: () => new Date("2026-09-30T06:00:00Z"),
  };
  const r = await runWorkflow(scoutWorkflow(), { store: new WorkflowStore(), runId: "corpus", ctx });
  assert.equal(r.status, "completed", JSON.stringify(r.nodes));
  const cards = (r.nodes.publish?.output as { json: { cards: Card[] } }).json.cards;
  const cardLines: BriefLine[] = cards.flatMap((c) => [...c.whyPassed, ...c.wouldProveWrong, ...c.caseAgainst]).filter((l) => l.claimIds.length > 0);

  // the daily brief, in the same ledger: a level, a rate and an event series
  const series = (id: string, label: string, unit: string, kind: SeriesPayload["kind"], prior: number, latest: number): SeriesPayload => ({
    series: id, label, unit, kind, observations: [], latest: { date: "2026-09-29", value: latest }, prior: { date: "2026-09-28", value: prior },
  });
  const provider = new FixtureProvider("ecb-fixture", {
    "EXR.USD": series("EXR.USD", "EUR/USD reference rate", "USD", "level", 1.1378, 1.1355),
    "EST.ESTR": series("EST.ESTR", "Euro short-term rate", "%", "rate", 2.19, 2.44),
    "FM.DFR": series("FM.DFR", "ECB deposit facility rate", "%", "event", 2.25, 2.5),
  });
  const today = await runWorkflow(todayWorkflow(), {
    store: new WorkflowStore(), runId: "corpus-today",
    ctx: { ledger, table, provider, analyst: new TemplateAnalyst(), verifier: new RulesVerifier(ALL_RECOMPUTE), watchlist: ["EXR.USD", "EST.ESTR", "FM.DFR"], theses: [], displayContext: "local_user", now: () => new Date("2026-09-30T06:00:00Z") },
  });
  assert.equal(today.status, "completed", JSON.stringify(today.nodes));
  const briefLines = (today.nodes.publish?.output as { json: { lines: BriefLine[] } }).json.lines;
  return { ledger, ctx, cards, lines: [...cardLines, ...briefLines] };
}

const audit = (lines: BriefLine[], ledger: EvidenceLedger, context: "local_user" | "hosted_paid" | "public" = "local_user") =>
  claimsAudit({ title: "t", generatedAt: "", lines }, ledger, { context, recompute: ALL_RECOMPUTE });

/** Every way to corrupt each number in a line: shift the decimal point, off by one, flip the sign. */
function numberMutations(text: string): { mutated: string; from: string; to: string }[] {
  const dateSpans = [...text.matchAll(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g)].map((m) => [m.index as number, (m.index as number) + m[0].length]);
  const out: { mutated: string; from: string; to: string }[] = [];
  for (const m of text.matchAll(/-?\d+(?:[.,]\d+)*/g)) {
    const at = m.index as number;
    if (dateSpans.some(([a, b]) => at >= (a as number) && at < (b as number))) continue;
    const n = Number(m[0].replace(/,/g, ""));
    if (!Number.isFinite(n) || n === 0) continue;
    for (const v of [n * 10, n / 10, n + 1, -n]) {
      const shown = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 100) / 100);
      out.push({ mutated: text.slice(0, at) + shown + text.slice(at + m[0].length), from: m[0], to: shown });
    }
  }
  return out;
}

test("control: unmutated cards and briefs raise no findings, from either checker (zero false alarms)", async () => {
  const { ledger, lines } = await build();
  assert.ok(lines.length >= 10, `${lines.length} lines under test`);
  assert.deepEqual(audit(lines, ledger).findings, []);
  assert.deepEqual(new RulesVerifier(ALL_RECOMPUTE).check(lines, ledger).issues, []);
});

test("A. every corrupted number in every line is caught (measured catch rate must be 100%)", async () => {
  const { ledger, lines } = await build();
  let planted = 0;
  let caught = 0;
  const missed: string[] = [];
  for (const line of lines) {
    for (const m of numberMutations(line.text)) {
      planted++;
      const r = audit([{ text: m.mutated, claimIds: line.claimIds }], ledger);
      if (!r.passed) caught++;
      else missed.push(`${m.from} -> ${m.to} in "${line.text.slice(0, 90)}"`);
    }
  }
  console.log(`  A. number corruption: planted ${planted}, caught ${caught}, missed ${planted - caught}`);
  for (const m of missed) console.log(`     missed: ${m}`);
  assert.ok(planted >= 80, `corpus is large enough (${planted})`);
  assert.deepEqual(missed, [], `${missed.length} corrupted numbers slipped through`);
});

test("B. every tampered evidence link is caught by the audit and by the independent verifier", async () => {
  const { ledger } = await build();
  const ids = (ledger.db.prepare("SELECT id FROM claims").all() as { id: string }[]).map((r) => r.id);
  let planted = 0;
  let auditCaught = 0;
  let verifierCaught = 0;
  const missed: string[] = [];
  let n = 0;
  for (const id of ids) {
    const claim = ledger.getClaim(id)!;
    claim.links.forEach((link, i) => {
      const variants: (number | string)[] = /^-?\d/.test(String(link.value)) && Number.isFinite(Number(link.value)) && typeof link.value !== "string"
        ? [Number(link.value) * 10, Number(link.value) + 1, -Number(link.value)]
        : Number.isFinite(Number(link.value)) ? [Number(link.value) * 10, Number(link.value) + 1, -Number(link.value)] : [`${link.value}x`, "1999-01-01"];
      for (const v of variants) {
        if (v === 0 || v === link.value) continue;
        const bad = ledger.addClaim({
          text: claim.text, kind: "fact", producedBy: "planted", runId: `planted-${n++}`,
          links: claim.links.map((l, j) => ({ sourceId: l.sourceId, kind: l.kind, fieldOrQuote: l.fieldOrQuote, value: j === i ? (v as number | string) : (l.value as number | string | null) })),
        });
        const line = { text: claim.text, claimIds: [bad.id] };
        planted++;
        if (!audit([line], ledger).passed) auditCaught++;
        else missed.push(`audit: ${link.fieldOrQuote} ${String(link.value)} -> ${String(v)}`);
        if (!new RulesVerifier(ALL_RECOMPUTE).check([line], ledger).passed) verifierCaught++;
      }
    });
  }
  console.log(`  B. tampered links: planted ${planted}, audit caught ${auditCaught}, verifier caught ${verifierCaught}`);
  assert.ok(planted >= 60);
  assert.deepEqual(missed, []);
  assert.equal(verifierCaught, planted, "the independent verifier alone also catches every tampered link");
});

test("C. tampering with any stored source is detected by re-hashing", async () => {
  let planted = 0;
  let caught = 0;
  const count = (await build()).ledger.db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number };
  for (let s = 0; s < count.n; s++) {
    const { ledger } = await build();
    const row = ledger.db.prepare("SELECT id, payload FROM sources ORDER BY id LIMIT 1 OFFSET ?").get(s) as { id: string; payload: string };
    const altered = row.payload.replace(/(\d+)/, (d) => String(Number(d) + 1));
    ledger.db.exec("DROP TRIGGER sources_no_update");
    ledger.db.prepare("UPDATE sources SET payload = ? WHERE id = ?").run(altered, row.id);
    planted++;
    if (ledger.verify().includes(row.id)) caught++;
  }
  console.log(`  C. tampered sources: planted ${planted}, caught ${caught}`);
  assert.equal(caught, planted);
});

test("D. missing, unknown and borrowed citations are caught", async () => {
  const { ledger, lines, cards } = await build();
  const numeric = lines.filter((l) => numbersIn(l.text).length > 0);
  let planted = 0;
  let caught = 0;
  const foreign = ledger.db.prepare("SELECT id FROM claims WHERE text LIKE 'STEADYCO%' LIMIT 1").get() as { id: string };
  const strongLines = cards.find((c) => c.ticker === "STRONG")!.whyPassed;
  const missed: string[] = [];
  for (const l of numeric) {
    planted += 2;
    if (!audit([{ text: l.text, claimIds: [] }], ledger).passed) caught++; // citation removed
    else missed.push(`removed: ${l.text.slice(0, 80)}`);
    if (!audit([{ text: l.text, claimIds: ["deadbeefdeadbeef"] }], ledger).passed) caught++; // citation invented
    else missed.push(`invented: ${l.text.slice(0, 80)}`);
  }
  for (const l of strongLines) {
    planted++;
    if (!audit([{ text: l.text, claimIds: [foreign.id] }], ledger).passed) caught++; // another company's claim borrowed
    else missed.push(`borrowed: ${l.text.slice(0, 80)}  <- ${ledger.getClaim(foreign.id)?.text.slice(0, 80)}`);
  }
  console.log(`  D. citations: planted ${planted}, caught ${caught}`);
  for (const m of missed) console.log(`     missed: ${m}`);
  assert.deepEqual(missed, []);
});

test("E. fabricated and altered quotations are caught byte for byte", () => {
  const ledger = new EvidenceLedger();
  const sentence = "Net revenues increased 12% driven by higher subscription volumes.";
  const src = ledger.addSource({ provider: "p", url: "u://filing", asOf: "2026-01-01", retrievedAt: "2026-01-02T00:00:00Z", licenceClass: "public", delayedBySeconds: 0, payload: `Management said: "${sentence}" Outlook is unchanged.` });
  const quote = (q: string, id: string) => ledger.addClaim({ text: `The filing says ${q}`, kind: "fact", producedBy: "t", runId: id, links: [{ sourceId: src.id, kind: "quote", fieldOrQuote: q }] });
  const variants = [
    sentence.toLowerCase(), sentence.replace("12%", "21%"), sentence.replace("increased", "rose"), sentence.replace("higher ", ""),
    ` ${sentence}`, sentence.replace(/ /, "  "), sentence.replace("Net", "Gross"), `${sentence} Guidance raised.`,
  ];
  // controls: the whole sentence, and a true partial quote (an exact substring), are genuine quotations
  for (const q of [sentence, sentence.slice(0, -1), "Net revenues increased 12%"]) {
    const good = quote(q, `good-${q.length}`);
    assert.equal(claimsAudit({ title: "t", generatedAt: "", lines: [{ text: good.text, claimIds: [good.id] }] }, ledger, { context: "local_user" }).findings.filter((f) => f.code === "QUOTE_MISMATCH").length, 0, q);
  }
  let caught = 0;
  variants.forEach((q, i) => {
    const c = quote(q, `v${i}`);
    const r = claimsAudit({ title: "t", generatedAt: "", lines: [{ text: c.text, claimIds: [c.id] }] }, ledger, { context: "local_user" });
    if (r.findings.some((f) => f.code === "QUOTE_MISMATCH")) caught++;
  });
  console.log(`  E. quotations: planted ${variants.length}, caught ${caught}`);
  assert.equal(caught, variants.length);
});

test("F. mandate-derived evidence and simulation-only data are refused where the licence forbids", async () => {
  const { ledger, lines } = await build();
  const hosted = audit(lines, ledger, "hosted_paid");
  assert.ok(hosted.findings.some((f) => f.code === "DISPLAY_BLOCKED"));
  const daily = { provider: new FixtureProvider("sim", { X: { series: "X", label: "X", unit: "", observations: [], latest: { date: "2026-09-29", value: 2 }, prior: null } }, { licenceClass: "sim_only" }) };
  const d = await daily.provider.fetchSeries("X");
  const s = ledger.addSource(d);
  const c = ledger.addClaim({ text: "X was 2 on 2026-09-29", kind: "fact", producedBy: "t", runId: "sim", links: [{ sourceId: s.id, kind: "field", fieldOrQuote: "latest.value", value: 2 }] });
  assert.equal(audit([{ text: c.text, claimIds: [c.id] }], ledger, "public").passed, false);
  assert.equal(audit([{ text: c.text, claimIds: [c.id] }], ledger, "local_user").passed, true);
});
