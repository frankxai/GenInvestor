import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicyTable } from "../src/contracts.ts";
import { runWorkflow, WorkflowStore } from "../src/graph.ts";
import { EvidenceLedger } from "../src/ledger.ts";
import { FixtureProvider } from "../src/providers.ts";
import type { SeriesPayload } from "../src/providers.ts";
import { ageInDays, DISCLOSURE, RulesVerifier, TemplateAnalyst, todayWorkflow } from "../src/today.ts";
import type { Analyst, TodayContext } from "../src/today.ts";

const table = loadPolicyTable();

const series = (id: string, label: string, unit: string, prior: number, latest: number): SeriesPayload => ({
  series: id,
  label,
  unit,
  observations: [
    { date: "2026-09-28", value: prior },
    { date: "2026-09-29", value: latest },
  ],
  latest: { date: "2026-09-29", value: latest },
  prior: { date: "2026-09-28", value: prior },
});

const DATA = {
  "EXR.USD": series("EXR.USD", "US dollar/Euro ECB reference exchange rate", "USD", 1.1378, 1.1355),
  "FM.DFR": series("FM.DFR", "ECB deposit facility rate", "PCPA", 2, 2),
};

function ctx(over: Partial<TodayContext> = {}): TodayContext {
  return {
    ledger: new EvidenceLedger(),
    table,
    provider: new FixtureProvider("ecb-fixture", DATA),
    analyst: new TemplateAnalyst(),
    verifier: new RulesVerifier(),
    watchlist: ["EXR.USD", "FM.DFR"],
    theses: [],
    displayContext: "local_user",
    ...over,
  };
}

test("end to end: a clean run publishes a sourced brief with freshness chips and the disclosure", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "geninvestor-"));
  const c = ctx({ outDir });
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "r1", ctx: c });
  assert.equal(report.status, "completed", JSON.stringify(report.nodes));
  const md = readFileSync(join(outDir, "brief.md"), "utf8");
  assert.match(md, /US dollar\/Euro ECB reference exchange rate was 1\.1355 USD on 2026-09-29, down 0\.2% on the prior observation/);
  assert.match(md, /ecb-fixture, as of 2026-09-29, retrieved 2026-09-30T06:00Z/);
  assert.match(md, /unchanged on the prior observation/);
  assert.ok(md.includes(DISCLOSURE));
  assert.deepEqual(c.ledger.verify(), []);
});

test("every published figure opens to a ledger chain with source, as-of and retrieval time", async () => {
  const c = ctx();
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "r2", ctx: c });
  const { json } = (report.nodes.publish?.output as { json: { lines: { claimIds: string[] }[] } });
  for (const line of json.lines) {
    for (const id of line.claimIds) {
      const chain = c.ledger.explain(id);
      assert.ok(chain && chain.sources.length > 0);
      assert.ok(chain.sources.every((s) => s.source?.asOf && s.source.retrievedAt && s.source.sha256));
    }
  }
});

test("a writer that invents a number is stopped by the claims audit and nothing is published", async () => {
  const liar: Analyst = {
    provider: "liar",
    write: (figures) => [...figures.map((f) => ({ text: f.claimText, claimIds: [f.claimId] })), { text: "Bund yields jumped 41 basis points overnight.", claimIds: [] }],
  };
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "r3", ctx: ctx({ analyst: liar }) });
  assert.equal(report.status, "blocked");
  assert.equal(report.nodes.audit?.status, "blocked");
  assert.match(report.nodes.audit?.reason ?? "", /UNLINKED_NUMBER/);
  assert.equal(report.nodes.publish?.status, "skipped");
});

test("a writer that cites a real claim but changes its number is stopped", async () => {
  const sloppy: Analyst = {
    provider: "sloppy",
    write: (figures) => figures.map((f) => ({ text: f.claimText.replace("1.1355", "1.2355"), claimIds: [f.claimId] })),
  };
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "r4", ctx: ctx({ analyst: sloppy }) });
  assert.match(report.nodes.audit?.reason ?? "", /NUMBER_NOT_IN_CLAIMS/);
  assert.equal(report.nodes.publish?.status, "skipped");
});

test("the verifier must come from a different provider than the writer", async () => {
  const same = { provider: "template", check: () => ({ passed: true, issues: [] }) };
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "r5", ctx: ctx({ verifier: same }) });
  assert.equal(report.nodes.verify?.status, "blocked");
  assert.match(report.nodes.verify?.reason ?? "", /must differ from the writer/);
  assert.equal(report.nodes.publish?.status, "skipped");
});

test("a thesis past its kill line waits for a human, and publishes only after approval", async () => {
  const store = new WorkflowStore();
  const theses = [{ id: "usd-strength", claim: "EUR/USD stays under 1.10", killCriteria: [{ seriesId: "EXR.USD", op: ">" as const, threshold: 1.1 }] }];
  const c = ctx({ theses });
  const first = await runWorkflow(todayWorkflow(), { store, runId: "r6", ctx: c });
  assert.equal(first.status, "waiting_human");
  assert.match(first.nodes.human?.reason ?? "", /usd-strength/);
  assert.equal(first.nodes.publish?.status, "skipped");

  store.approve("r6", "human", "alice", "approved");
  const second = await runWorkflow(todayWorkflow(), { store, runId: "r6", ctx: c });
  assert.equal(second.status, "completed");
  assert.equal(second.nodes.fetch?.reused, true, "earlier work is not redone");
  const md = (second.nodes.publish?.output as { markdown: string }).markdown;
  assert.match(md, /usd-strength: \*\*broken\*\*/);
});

test("a thesis near but not past its line is on watch and does not stop the run", async () => {
  const theses = [{ id: "near", claim: "c", killCriteria: [{ seriesId: "EXR.USD", op: ">" as const, threshold: 1.17 }] }];
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "r7", ctx: ctx({ theses }) });
  assert.equal(report.status, "completed");
  assert.match((report.nodes.publish?.output as { markdown: string }).markdown, /near: \*\*watch\*\*/);
});

test("sim-only data cannot be shown in a hosted paid context", async () => {
  const provider = new FixtureProvider("sim", DATA, { licenceClass: "sim_only" });
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "r8", ctx: ctx({ provider, displayContext: "hosted_paid" }) });
  assert.equal(report.nodes.audit?.status, "blocked");
  assert.match(report.nodes.audit?.reason ?? "", /DISPLAY_BLOCKED/);
});

const RATES = {
  "R.RATE": { ...series("R.RATE", "Policy rate", "%", 2.25, 2.5), kind: "rate" as const, maxAgeDays: 6 },
  "R.EVENT": { ...series("R.EVENT", "Deposit facility rate", "%", 2.25, 2.5), kind: "event" as const, maxAgeDays: null },
};

test("rates are described in percentage points, never as a percent of a percent", async () => {
  const c = ctx({ provider: new FixtureProvider("f", RATES), watchlist: ["R.RATE", "R.EVENT"] });
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "k1", ctx: c });
  assert.equal(report.status, "completed", JSON.stringify(report.nodes));
  const md = (report.nodes.publish?.output as { markdown: string }).markdown;
  assert.match(md, /Policy rate was 2\.5% on 2026-09-29, up 0\.25 percentage points on the prior observation/);
  assert.match(md, /Deposit facility rate was set to 2\.5% on 2026-09-29, from 2\.25%/);
  assert.doesNotMatch(md, /11\.11/);
});

test("stale data is flagged in the line, in a data-quality section, and in the json", async () => {
  const c = ctx({ provider: new FixtureProvider("f", RATES), watchlist: ["R.RATE"], now: () => new Date("2026-12-31T00:00:00Z") });
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "k2", ctx: c });
  const out = report.nodes.publish?.output as { markdown: string; json: { stale: string[] } };
  assert.match(out.markdown, /⚠ stale, 93 days old/);
  assert.match(out.markdown, /## Data quality/);
  assert.deepEqual(out.json.stale, ["R.RATE"]);
});

test("event series are never flagged stale, and fresh data is not flagged", async () => {
  const c = ctx({ provider: new FixtureProvider("f", RATES), watchlist: ["R.EVENT", "R.RATE"], now: () => new Date("2026-09-30T00:00:00Z") });
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "k3", ctx: c });
  assert.doesNotMatch((report.nodes.publish?.output as { markdown: string }).markdown, /stale/);
});

test("a thesis whose criterion rests on stale data goes on watch instead of being judged", async () => {
  const theses = [{ id: "t", claim: "c", killCriteria: [{ seriesId: "R.RATE", op: ">" as const, threshold: 1 }] }];
  const c = ctx({ provider: new FixtureProvider("f", RATES), watchlist: ["R.RATE"], theses, now: () => new Date("2026-12-31T00:00:00Z") });
  const report = await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "k4", ctx: c });
  assert.equal(report.status, "completed", "stale data must not trigger a broken verdict");
  assert.match((report.nodes.publish?.output as { markdown: string }).markdown, /t: \*\*watch\*\*.*cannot be checked/);
});

test("ageInDays handles daily and monthly observation dates", () => {
  assert.equal(ageInDays(new Date("2026-09-30T00:00:00Z"), "2026-09-28"), 2);
  assert.equal(ageInDays(new Date("2026-01-31T00:00:00Z"), "2025-12"), 31);
  assert.equal(ageInDays(new Date("2026-01-01T00:00:00Z"), "2026-02-10"), 0, "future dates clamp to zero");
});

test("rerunning the same day is idempotent: same claims, no duplicate ledger rows", async () => {
  const c = ctx();
  const store = new WorkflowStore();
  await runWorkflow(todayWorkflow(), { store, runId: "r9", ctx: c });
  const claims = (c.ledger.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as { n: number }).n;
  await runWorkflow(todayWorkflow(), { store: new WorkflowStore(), runId: "r9b", ctx: c });
  assert.equal((c.ledger.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as { n: number }).n, claims);
});
