import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicyTable } from "../src/contracts.ts";
import { runWorkflow, WorkflowStore } from "../src/graph.ts";
import { EvidenceLedger } from "../src/ledger.ts";
import { EXAMPLE_MANDATE } from "../src/mandate.ts";
import type { Mandate } from "../src/mandate.ts";
import { MAX_CARDS, RulesSkeptic, SCOUT_RECOMPUTE, scoutWorkflow } from "../src/scout.ts";
import type { Card, FundamentalsSource, ScoutContext, Skeptic } from "../src/scout.ts";
import { extractPayload, metricsOf } from "../src/sec.ts";
import { RulesVerifier } from "../src/today.ts";

const table = loadPolicyTable();
const snowRaw = JSON.parse(readFileSync(new URL("./fixtures/sec/snow_facts.trimmed.json", import.meta.url), "utf8"));

interface Year { year: number; rev: number; op?: number; liab?: number; eq?: number }
function raw(cik: number, name: string, years: Year[]) {
  const flow = (k: "rev" | "op") => years.filter((y) => y[k] !== undefined).map((y) => ({ start: `${y.year}-01-01`, end: `${y.year}-12-31`, val: y[k], form: "10-K", fp: "FY", filed: `${y.year + 1}-02-15`, fy: y.year }));
  const inst = (k: "liab" | "eq") => years.filter((y) => y[k] !== undefined).map((y) => ({ end: `${y.year}-12-31`, val: y[k], form: "10-K", fp: "FY", filed: `${y.year + 1}-02-15`, fy: y.year }));
  return { cik, entityName: name, facts: { "us-gaap": { Revenues: { units: { USD: flow("rev") } }, OperatingIncomeLoss: { units: { USD: flow("op") } }, Liabilities: { units: { USD: inst("liab") } }, StockholdersEquity: { units: { USD: inst("eq") } } } } };
}

// Strong, but margin and growth are both slipping: the skeptic has material to work with.
const STRONG = raw(11, "STRONGCO INC", [
  { year: 2025, rev: 1_100_000_000, op: 275_000_000, liab: 600_000_000, eq: 400_000_000 },
  { year: 2024, rev: 1_000_000_000, op: 300_000_000, liab: 550_000_000, eq: 400_000_000 },
  { year: 2023, rev: 900_000_000, op: 260_000_000, liab: 500_000_000, eq: 380_000_000 },
]);
// Steady and improving: no adverse trend to find.
const STEADY = raw(12, "STEADYCO INC", [
  { year: 2025, rev: 1_200_000_000, op: 360_000_000, liab: 300_000_000, eq: 600_000_000 },
  { year: 2024, rev: 1_000_000_000, op: 280_000_000, liab: 300_000_000, eq: 550_000_000 },
  { year: 2023, rev: 850_000_000, op: 220_000_000, liab: 300_000_000, eq: 500_000_000 },
]);
const THIN = raw(13, "THINCO INC", [
  { year: 2025, rev: 500_000_000, op: 20_000_000, liab: 100_000_000, eq: 200_000_000 },
  { year: 2024, rev: 480_000_000, op: 20_000_000, liab: 100_000_000, eq: 190_000_000 },
]);

class FakeSec implements FundamentalsSource {
  calls: string[] = [];
  private readonly data: Record<string, unknown>;
  constructor(data: Record<string, unknown>) {
    this.data = data;
  }
  async fetchFundamentals(ticker: string, _cik?: string, asOf?: string) {
    this.calls.push(ticker);
    const r = this.data[ticker];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false as const, reason: "not in the fixture" };
    const e = extractPayload(r, ticker, { asOf });
    if (!e.ok) return e;
    return { ok: true as const, datum: { provider: "sec-edgar", url: `fixture://sec/${ticker}`, asOf: metricsOf(e.payload).fiscalYearEnd, retrievedAt: "2026-09-30T06:00:00.000Z", licenceClass: "public" as const, delayedBySeconds: 0, payload: e.payload } };
  }
}

const mandate = (over: Partial<Mandate> = {}): Mandate => ({ ...EXAMPLE_MANDATE, thresholds: { minRevenueGrowthPct: 8, minOperatingMarginPct: 20, maxLiabilitiesToEquity: 3 }, ...over });

function ctx(data: Record<string, unknown>, m: Mandate, over: Partial<ScoutContext> = {}): ScoutContext {
  return {
    ledger: new EvidenceLedger(),
    table,
    mandate: m,
    sec: new FakeSec(data),
    writer: { provider: "template-writer" },
    skeptic: new RulesSkeptic(),
    verifier: new RulesVerifier(SCOUT_RECOMPUTE),
    displayContext: "local_user",
    now: () => new Date("2026-09-30T06:00:00Z"),
    ...over,
  };
}

const run = (c: ScoutContext, id = "run") => runWorkflow(scoutWorkflow(), { store: new WorkflowStore(), runId: id, ctx: c });
const out = (r: Awaited<ReturnType<typeof run>>) => r.nodes.publish?.output as { markdown: string; json: { cards: Card[]; screen: any } };

test("end to end: a company that passes the rules becomes a fully sourced card with its case against", async () => {
  const c = ctx({ STRONG }, mandate({ watchlist: [{ ticker: "STRONG" }] }));
  const r = await run(c);
  assert.equal(r.status, "completed", JSON.stringify(r.nodes));
  const { cards, screen } = out(r).json;
  assert.equal(cards.length, 1);
  const card = cards[0] as Card;
  assert.equal(card.ticker, "STRONG");
  assert.equal(card.style, "quality");
  assert.equal(screen.passed, 1);
  assert.ok(card.whyPassed.some((l) => /operating margin was 25%/.test(l.text)), JSON.stringify(card.whyPassed));
  assert.ok(card.whyPassed.some((l) => /revenue of 1,100,000,000 USD .* up 10% from 1,000,000,000 USD/.test(l.text)));
  assert.ok(card.caseAgainst.some((l) => /moved from 30% a year earlier to 25%, a change of -5 percentage points/.test(l.text)));
  assert.ok(card.caseAgainst.some((l) => /Revenue growth was 10% against 11.11% the year before/.test(l.text)));
  assert.equal(card.suggestedCall.note, "A research criterion only; no forecast is registered.");
  assert.ok(!("probability" in card.suggestedCall));
  // every numeric line opens to a chain in the ledger
  for (const l of [...card.whyPassed, ...card.wouldProveWrong, ...card.caseAgainst]) {
    if (/\d/.test(l.text.replace(/\d{4}-\d{2}-\d{2}/g, ""))) {
      assert.ok(l.claimIds.length > 0, `unsourced numeric line: ${l.text}`);
      for (const id of l.claimIds) assert.ok(c.ledger.explain(id)?.sources.length);
    }
  }
  assert.deepEqual(c.ledger.verify(), []);
});

test("real Snowflake data fails both screens honestly: a growth company that is not profitable", async () => {
  const c = ctx({ SNOW: snowRaw }, mandate({ styles: ["quality", "growth"], watchlist: [{ ticker: "SNOW" }] }));
  const r = await run(c);
  assert.equal(r.status, "completed");
  const { cards, screen } = out(r).json;
  assert.equal(cards.length, 0, "growth 29.21% passes the growth line but a -40.15% operating margin fails profitability and quality");
  assert.equal(screen.screened, 1);
  assert.equal(screen.passed, 0);
  assert.match(out(r).markdown, /Zero is a valid result/);
});

test("a company with no adverse trend gets an honest 'nothing found' line, not an invented objection", async () => {
  const r = await run(ctx({ STEADY }, mandate({ watchlist: [{ ticker: "STEADY" }] })));
  const card = out(r).json.cards[0] as Card;
  assert.ok(card.caseAgainst.some((l) => /No adverse trend was found/.test(l.text)));
  assert.ok(card.caseAgainst.every((l) => l.claimIds.length === 0 || !/No adverse trend/.test(l.text)));
});

test("ranking is by fit with the mandate, capped at five, and ties break alphabetically", async () => {
  const data: Record<string, unknown> = {};
  const wl: { ticker: string }[] = [];
  for (let i = 0; i < 8; i++) {
    const margin = 21 + i; // later tickers fit better, all inside the 100% headroom cap against the 20% line
    data[`T${i}`] = raw(100 + i, `NAME ${i}`, [
      { year: 2025, rev: 1000, op: margin * 10, liab: 300, eq: 500 },
      { year: 2024, rev: 950, op: margin * 9.5, liab: 300, eq: 480 },
      { year: 2023, rev: 900, op: margin * 9, liab: 300, eq: 460 },
    ]);
    wl.push({ ticker: `T${i}` });
  }
  const { cards, screen } = out(await run(ctx(data, mandate({ watchlist: wl })))).json;
  assert.equal(screen.passed, 8);
  assert.equal(cards.length, MAX_CARDS);
  assert.deepEqual(cards.map((c) => c.ticker), ["T7", "T6", "T5", "T4", "T3"]);
});

test("headroom is capped, so a far larger figure earns no extra rank, and ties break alphabetically", async () => {
  const mk = (cik: number, margin: number) =>
    raw(cik, `CO ${cik}`, [
      { year: 2025, rev: 1000, op: margin * 10, liab: 300, eq: 500 },
      { year: 2024, rev: 950, op: margin * 9.5, liab: 300, eq: 480 },
    ]);
  const data = { ZED: mk(1, 40), ABE: mk(2, 90), MID: mk(3, 45) }; // all at or beyond twice the 20% line
  const { cards } = out(await run(ctx(data, mandate({ watchlist: [{ ticker: "ZED" }, { ticker: "ABE" }, { ticker: "MID" }] })))).json;
  assert.deepEqual(cards.map((c) => c.ticker), ["ABE", "MID", "ZED"]);
  assert.equal(new Set(cards.map((c) => c.score)).size, 1, "identical fit scores");
});

test("holdings and exclusions are honoured and never appear in any output", async () => {
  const data = { STRONG, STEADY, THIN, HELDCO: STRONG, BADCO: STRONG };
  const m = mandate({
    watchlist: [{ ticker: "STRONG" }, { ticker: "STEADY" }, { ticker: "THIN" }, { ticker: "HELDCO" }, { ticker: "BADCO" }],
    holdings: ["HELDCO"],
    exclusions: { tickers: ["BADCO"], keywords: ["thinco"] },
  });
  const c = ctx(data, m);
  const r = await run(c);
  const o = out(r);
  const blob = JSON.stringify(o.json) + o.markdown;
  assert.equal(o.json.screen.skippedHeld, 1);
  assert.equal(o.json.screen.skippedExcluded, 2, "one by ticker, one by keyword in the company name");
  assert.ok(!/HELDCO|BADCO|THINCO/i.test(blob), "held and excluded names are counted, never named");
  assert.deepEqual((c.sec as FakeSec).calls.sort(), ["STEADY", "STRONG", "THIN"], "held and excluded tickers are not even fetched");
  const mandateSource = c.ledger.db.prepare("SELECT payload FROM sources WHERE provider = 'mandate'").get() as { payload: string };
  assert.ok(!/HELDCO|BADCO|holdings|watchlist|exclusions/i.test(mandateSource.payload), "the mandate evidence carries rules only");
});

test("companies without usable data, and provider failures, are reported by reason and never crash the run", async () => {
  const data = { STRONG, NODATA: { cik: 5, entityName: "X", facts: {} }, BOOM: new Error("SEC refused the request (HTTP 403)") };
  const r = await run(ctx(data, mandate({ watchlist: [{ ticker: "STRONG" }, { ticker: "NODATA" }, { ticker: "BOOM" }, { ticker: "MISSING" }] })));
  assert.equal(r.status, "completed");
  const screen = out(r).json.screen;
  assert.equal(screen.screened, 1);
  assert.deepEqual(screen.noData.map((n: { ticker: string }) => n.ticker).sort(), ["BOOM", "MISSING", "NODATA"]);
  assert.match(screen.noData.find((n: { ticker: string }) => n.ticker === "BOOM").reason, /HTTP 403/);
  assert.match(screen.noData.find((n: { ticker: string }) => n.ticker === "NODATA").reason, /no US-GAAP/);
});

test("styles that cannot be run are said so in the screen record, and a mandate with no served market does nothing", async () => {
  const r = await run(ctx({ STRONG }, mandate({ styles: ["value", "special-situation", "quality"], watchlist: [{ ticker: "STRONG" }] })));
  const s = out(r).json.screen;
  assert.deepEqual(s.stylesRun, ["quality"]);
  assert.deepEqual(s.stylesUnavailable.map((x: { style: string }) => x.style), ["value", "special-situation"]);
  assert.match(out(r).markdown, /Style value was skipped: needs price data/);
  const crypto = await run(ctx({ STRONG }, mandate({ markets: ["crypto"], watchlist: [{ ticker: "STRONG" }] })));
  assert.equal(out(crypto).json.cards.length, 0);
  assert.match(out(crypto).json.screen.noData[0].reason, /only us-equities is supported/);
});

test("the writer, the skeptic and the verifier must be three different providers", async () => {
  const same: Skeptic = { provider: "template-writer", argue: () => [] };
  const r1 = await run(ctx({ STRONG }, mandate({ watchlist: [{ ticker: "STRONG" }] }), { skeptic: same }));
  assert.equal(r1.nodes.skeptic?.status, "blocked");
  assert.match(r1.nodes.skeptic?.reason ?? "", /must differ from the writer/);
  assert.equal(r1.nodes.publish?.status, "skipped");
  const r2 = await run(ctx({ STRONG }, mandate({ watchlist: [{ ticker: "STRONG" }] }), { verifier: { provider: "rules-skeptic", check: () => ({ passed: true, issues: [] }) } }));
  assert.equal(r2.nodes.verify?.status, "blocked");
  assert.equal(r2.nodes.publish?.status, "skipped");
});

test("a skeptic that invents a number is stopped by the audit and nothing is published", async () => {
  const liar: Skeptic = { provider: "liar", argue: () => [{ text: "Insiders sold 41 million dollars of stock last quarter.", claimIds: [] }] };
  const r = await run(ctx({ STRONG }, mandate({ watchlist: [{ ticker: "STRONG" }] }), { skeptic: liar }));
  assert.equal(r.status, "blocked");
  assert.match(r.nodes.audit?.reason ?? "", /UNLINKED_NUMBER/);
  assert.equal(r.nodes.publish?.status, "skipped");
});

test("a skeptic that cites a real claim but changes its number is stopped", async () => {
  const sloppy: Skeptic = {
    provider: "sloppy",
    argue: ({ ledger, card }) => {
      const id = card.whyPassed[0]!.claimIds[0]!;
      const text = (ledger.getClaim(id)?.text ?? "").replace("25%", "31%");
      return [{ text, claimIds: [id] }];
    },
  };
  const r = await run(ctx({ STRONG }, mandate({ watchlist: [{ ticker: "STRONG" }] }), { skeptic: sloppy }));
  assert.equal(r.status, "blocked");
  assert.match(r.nodes.audit?.reason ?? "", /NUMBER_NOT_IN_CLAIMS/);
});

test("rules from the mandate cannot be displayed in a hosted or public context", async () => {
  const r = await run(ctx({ STRONG }, mandate({ watchlist: [{ ticker: "STRONG" }] }), { displayContext: "hosted_paid" }));
  assert.equal(r.nodes.audit?.status, "blocked");
  assert.match(r.nodes.audit?.reason ?? "", /DISPLAY_BLOCKED/);
});

test("no output contains action or hype language", async () => {
  const deny = [/\byou should (buy|sell|hold|trim|exit|add)\b/i, /\b(buy|sell) (this|it|now)\b/i, /\bgo (long|short)\b/i, /\b(increase|reduce|trim|exit) (the |your )?position\b/i, /\bprice target\b/i, /\b(top pick|can'?t miss|guaranteed|undervalued gem)\b/i];
  for (const data of [{ STRONG }, { STEADY }]) {
    const t = Object.keys(data)[0]!;
    const md = out(await run(ctx(data, mandate({ watchlist: [{ ticker: t }] })))).markdown;
    for (const rx of deny) assert.ok(!rx.test(md), `${rx} in output`);
    assert.match(md, /Candidates for research/);
    assert.match(md, /Information, not advice/);
  }
});

test("a historical run sees only what was public then: the same company passes, or not, depending on the date", async () => {
  // Margin was 30% in FY2023 and 12% in FY2024 (filed 2025-02-15). The FY2024 report cannot influence a 2024 screen.
  const FADING = raw(31, "FADINGCO INC", [
    { year: 2024, rev: 1_050_000_000, op: 126_000_000, liab: 300_000_000, eq: 500_000_000 },
    { year: 2023, rev: 1_000_000_000, op: 300_000_000, liab: 300_000_000, eq: 480_000_000 },
    { year: 2022, rev: 900_000_000, op: 250_000_000, liab: 300_000_000, eq: 460_000_000 },
  ]);
  const m = mandate({ watchlist: [{ ticker: "FADING" }] });
  const then = await run(ctx({ FADING }, m, { asOf: "2024-06-01", now: () => new Date("2024-06-01T12:00:00Z") }));
  const cardThen = out(then).json.cards[0] as Card;
  assert.ok(cardThen, "on 2024-06-01 the latest public report shows a 30% margin, so it passes");
  assert.ok(cardThen.whyPassed.some((l) => /operating margin was 30%/.test(l.text)));
  assert.equal(cardThen.asOf, "2023-12-31");
  assert.match(cardThen.suggestedCall.claim, /fiscal year ending 2024-12-31/);
  const now = await run(ctx({ FADING }, m, { asOf: "2025-06-01", now: () => new Date("2025-06-01T12:00:00Z") }), "later");
  assert.equal(out(now).json.cards.length, 0, "on 2025-06-01 the FY2024 report is public: margin 12% fails the 20% line");
  // the evidence itself records the cutoff
  const c = ctx({ FADING }, m, { asOf: "2024-06-01", now: () => new Date("2024-06-01T12:00:00Z") });
  await run(c, "evidence");
  const row = c.ledger.db.prepare("SELECT payload FROM sources WHERE provider = 'sec-edgar'").get() as { payload: string };
  assert.equal(JSON.parse(row.payload).knownAsOf, "2024-06-01");
});

test("a real card can be masked for a model to read: no name, ticker or date survives, and every figure does", async () => {
  const { Masker } = await import("../src/masking.ts");
  const c = ctx({ STRONG }, mandate({ watchlist: [{ ticker: "STRONG" }] }));
  const card = (out(await run(c)).json.cards[0]) as Card;
  const m = new Masker({ seed: "run-7", today: "2026-09-30" });
  m.register({ ticker: "STRONG", name: "STRONGCO INC" });
  const masked = m.maskDeep(card);
  const blob = JSON.stringify(masked);
  assert.deepEqual(m.audit(blob), [], "the auditor finds nothing left to mask");
  assert.ok(!/STRONGCO|STRONG\b|2025|2026|2027/.test(blob.replace(/ASSET-[0-9A-F]+/g, "")), blob.slice(0, 300));
  const figures = (t: string) => t.match(/\d[\d,]*\.?\d*%?/g)?.filter((x) => x.length > 2) ?? [];
  const original = JSON.stringify(card.whyPassed.map((l) => l.text)).replace(/\d{4}-\d{2}-\d{2}/g, " ");
  const stated = figures(original).map((x) => x.replace(/,$/, "")).filter((x) => /,|%|\./.test(x));
  assert.ok(stated.length >= 4, `figures under test: ${stated.join(" ")}`);
  for (const f of stated) assert.ok(blob.includes(f), `figure ${f} survived masking`);
  assert.equal(masked.score, card.score);
  assert.deepEqual(masked.whyPassed.map((l) => l.claimIds), card.whyPassed.map((l) => l.claimIds));
  assert.equal(m.unmask(masked.name), "STRONGCO INC");
});

test("the suggested call always names an annual report that has not been filed yet, and the calibration ledger accepts it", async () => {
  const { CalibrationLedger } = await import("../src/calibration.ts");
  const { nextReportWindow } = await import("../src/scout.ts");
  assert.deepEqual(nextReportWindow("2025-12-31", new Date("2026-09-30T00:00:00Z")), { nextEnd: "2026-12-31", resolvesOn: "2027-03-31" });
  assert.deepEqual(nextReportWindow("2022-01-31", new Date("2026-09-30T00:00:00Z")), { nextEnd: "2027-01-31", resolvesOn: "2027-05-01" }, "an old latest filing rolls forward past today");
  assert.deepEqual(nextReportWindow("2025-09-30", new Date("2026-09-30T00:00:00Z")), { nextEnd: "2026-09-30", resolvesOn: "2026-12-29" }, "the report for the year that just ended is still ahead");

  // an old filing, screened today: the suggested call must still be registrable
  const OLD = raw(21, "OLDCO INC", [
    { year: 2022, rev: 1_100_000_000, op: 330_000_000, liab: 300_000_000, eq: 500_000_000 },
    { year: 2021, rev: 1_000_000_000, op: 300_000_000, liab: 300_000_000, eq: 480_000_000 },
    { year: 2020, rev: 900_000_000, op: 260_000_000, liab: 300_000_000, eq: 460_000_000 },
  ]);
  const now = new Date("2026-09-30T06:00:00Z");
  const card = (out(await run(ctx({ OLD }, mandate({ watchlist: [{ ticker: "OLD" }] })))).json.cards[0]) as Card;
  const cal = new CalibrationLedger(":memory:", () => now);
  const registered = cal.register({ claim: card.suggestedCall.claim, probability: 0.7, resolvesOn: card.suggestedCall.resolvesOn, resolutionSource: card.suggestedCall.resolutionSource });
  assert.equal(registered.resolvesOn, card.suggestedCall.resolvesOn, "accepted exactly as suggested");
  assert.ok(card.suggestedCall.resolvesOn > "2026-09-30");
  assert.match(card.suggestedCall.claim, /fiscal year ending 2026-12-31/);
});

test("the published json conforms to the opportunities contract, which has no place for a probability or an action", async () => {
  const { validate } = await import("../../contracts/src/validate.ts");
  const { loadSchema } = await import("../src/contracts.ts");
  const schema = loadSchema("opportunities") as Parameters<typeof validate>[0];
  const good = out(await run(ctx({ STRONG, STEADY, SNOW: snowRaw }, mandate({ watchlist: [{ ticker: "STRONG" }, { ticker: "STEADY" }, { ticker: "SNOW" }] }))));
  assert.equal(good.json.cards.length, 2);
  assert.deepEqual(validate(schema, good.json), []);
  const empty = out(await run(ctx({ SNOW: snowRaw }, mandate({ watchlist: [{ ticker: "SNOW" }] })), "empty"));
  assert.deepEqual(validate(schema, empty.json), [], "a run with zero cards is valid");
  // the contract refuses the fields that would turn a card into advice
  const card = good.json.cards[0] as unknown as Record<string, unknown>;
  for (const [field, value] of [["recommendation", "buy"], ["priceTarget", 120], ["positionSize", 5]] as const) {
    assert.ok(validate(schema, { ...good.json, cards: [{ ...card, [field]: value }] }).some((e) => /unexpected property/.test(e)), field);
  }
  const call = { ...(card.suggestedCall as object), probability: 0.7 };
  assert.ok(validate(schema, { ...good.json, cards: [{ ...card, suggestedCall: call }] }).some((e) => /unexpected property "probability"/.test(e)));
});

test("outputs are written to disk and the same run is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-"));
  const c = ctx({ STRONG }, mandate({ watchlist: [{ ticker: "STRONG" }] }), { outDir: dir });
  const store = new WorkflowStore();
  await runWorkflow(scoutWorkflow(), { store, runId: "same", ctx: c });
  const claims = (c.ledger.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as { n: number }).n;
  const again = await runWorkflow(scoutWorkflow(), { store, runId: "same", ctx: c });
  assert.equal(again.nodes.fetch?.reused, true);
  assert.equal((c.ledger.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as { n: number }).n, claims);
  assert.match(readFileSync(join(dir, "opportunities.md"), "utf8"), /# Opportunities, 2026-09-30/);
  assert.equal(JSON.parse(readFileSync(join(dir, "opportunities.json"), "utf8")).cards.length, 1);
});
