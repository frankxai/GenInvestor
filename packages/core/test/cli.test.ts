// End-to-end: the real command line, as a person would run it. Each test spawns the CLI process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXAMPLE_MANDATE } from "../src/mandate.ts";

const BIN = fileURLToPath(new URL("../bin/geninvestor.ts", import.meta.url));

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, GENINVESTOR_SEC_IDENTITY: "", ...env },
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function facts(name: string, cik: number, years: { year: number; rev: number; op: number; liab: number; eq: number }[]) {
  const flow = (k: "rev" | "op") => years.map((y) => ({ start: `${y.year}-01-01`, end: `${y.year}-12-31`, val: y[k], form: "10-K", fp: "FY", filed: `${y.year + 1}-02-15` }));
  const inst = (k: "liab" | "eq") => years.map((y) => ({ end: `${y.year}-12-31`, val: y[k], form: "10-K", fp: "FY", filed: `${y.year + 1}-02-15` }));
  return { cik, entityName: name, facts: { "us-gaap": { Revenues: { units: { USD: flow("rev") } }, OperatingIncomeLoss: { units: { USD: flow("op") } }, Liabilities: { units: { USD: inst("liab") } }, StockholdersEquity: { units: { USD: inst("eq") } } } } };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "gi-cli-"));
  const factsDir = join(dir, "facts");
  mkdirSync(factsDir);
  writeFileSync(join(factsDir, "STRONG.json"), JSON.stringify(facts("STRONGCO INC", 11, [
    { year: 2025, rev: 1_100_000_000, op: 275_000_000, liab: 600_000_000, eq: 400_000_000 },
    { year: 2024, rev: 1_000_000_000, op: 300_000_000, liab: 550_000_000, eq: 400_000_000 },
    { year: 2023, rev: 900_000_000, op: 260_000_000, liab: 500_000_000, eq: 380_000_000 },
  ])));
  writeFileSync(join(factsDir, "HELD.json"), JSON.stringify(facts("HELDCO INC", 12, [
    { year: 2025, rev: 1_100_000_000, op: 275_000_000, liab: 600_000_000, eq: 400_000_000 },
    { year: 2024, rev: 1_000_000_000, op: 300_000_000, liab: 550_000_000, eq: 400_000_000 },
  ])));
  const mandate = { ...EXAMPLE_MANDATE, thresholds: { minRevenueGrowthPct: 8, minOperatingMarginPct: 20, maxLiabilitiesToEquity: 3 }, watchlist: [{ ticker: "STRONG" }, { ticker: "HELD" }], holdings: ["HELD"] };
  const mandateFile = join(dir, "mandate.json");
  writeFileSync(mandateFile, JSON.stringify(mandate));
  return { dir, factsDir, mandateFile, home: join(dir, "home") };
}

test("no arguments prints usage and succeeds; an unknown command fails with usage", () => {
  const none = cli([]);
  assert.equal(none.code, 0);
  assert.match(none.out, /Information, not advice/);
  const bad = cli(["frobnicate"]);
  assert.equal(bad.code, 2);
});

test("the gate answers through the command line, and its exit code says whether the action may proceed", () => {
  assert.equal(cli(["policy", "backtest"]).code, 0);
  const live = cli(["policy", "live_trade"]);
  assert.equal(live.code, 2);
  assert.match(live.out, /human_gate/);
  const secret = cli(["policy", "store_secret"]);
  assert.equal(secret.code, 2);
  assert.match(secret.out, /blocked/);
});

test("mandate: the printed example is valid, and a broken mandate is rejected with the reason", () => {
  const w = workspace();
  const example = cli(["mandate", "example"]);
  writeFileSync(join(w.dir, "example.json"), example.out);
  const ok = cli(["mandate", "check", join(w.dir, "example.json")]);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /mandate ok/);
  writeFileSync(join(w.dir, "broken.json"), JSON.stringify({ ...EXAMPLE_MANDATE, horizonYears: 0, styles: [] }));
  const bad = cli(["mandate", "check", join(w.dir, "broken.json")]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /horizonYears/);
  assert.match(bad.out, /mandate invalid/);
});

test("scout refuses to run without an SEC contact identity or a facts folder, and says how to fix it", () => {
  const w = workspace();
  const r = cli(["scout", "--mandate", w.mandateFile, "--home", w.home]);
  assert.equal(r.code, 1);
  assert.match(r.err, /GENINVESTOR_SEC_IDENTITY/);
  const badDate = cli(["scout", "--mandate", w.mandateFile, "--home", w.home, "--facts-dir", w.factsDir, "--as-of", "last june"]);
  assert.equal(badDate.code, 1);
  assert.match(badDate.err, /--as-of must be a date/);
  const noMandate = cli(["scout", "--mandate", join(w.dir, "missing.json"), "--home", w.home, "--facts-dir", w.factsDir]);
  assert.equal(noMandate.code, 1);
});

test("scout offline, end to end: a card is produced, every figure opens to its evidence, and held names never appear", () => {
  const w = workspace();
  const r = cli(["scout", "--mandate", w.mandateFile, "--home", w.home, "--facts-dir", w.factsDir]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /offline run/);
  assert.match(r.out, /run scout-\d{4}-\d{2}-\d{2}: completed/);
  assert.match(r.out, /## STRONGCO INC \(STRONG\)/);
  assert.match(r.out, /candidates for research, not recommendations/i);
  assert.ok(!/HELD/.test(r.out), "a held ticker is counted, never named");
  const md = readFileSync(join(w.home, "opportunities", "opportunities.md"), "utf8");
  const json = JSON.parse(readFileSync(join(w.home, "opportunities", "opportunities.json"), "utf8"));
  assert.ok(!/HELD/.test(md + JSON.stringify(json)));
  assert.equal(json.screen.skippedHeld, 1);
  assert.equal(json.cards.length, 1);
  assert.ok(!("probability" in json.cards[0].suggestedCall));

  // ask why: the evidence chain behind a claim on the card
  const claimId = json.cards[0].whyPassed[0].claimIds[0] as string;
  const why = cli(["explain", claimId, "--home", w.home]);
  assert.equal(why.code, 0);
  assert.match(why.out, /source sec-edgar-file/);
  assert.match(why.out, /sha256/);
  assert.equal(cli(["verify", "--home", w.home]).code, 0);
});

test("scout --as-of runs point-in-time: before the second annual report there is nothing to screen", () => {
  const w = workspace();
  const read = () => JSON.parse(readFileSync(join(w.home, "opportunities", "opportunities.json"), "utf8"));
  // by 2024-06-01 only the FY2023 report is public: one annual report is not enough to compute growth
  const early = cli(["scout", "--mandate", w.mandateFile, "--home", w.home, "--facts-dir", w.factsDir, "--as-of", "2024-06-01"]);
  assert.equal(early.code, 0, early.err + early.out);
  assert.match(early.out, /point-in-time run: only filings public on or before 2024-06-01/);
  assert.equal(read().cards.length, 0);
  assert.match(JSON.stringify(read().screen.noData), /had been filed by 2024-06-01/);
  // by 2025-06-01 the FY2024 report is public too: the same company now screens, on FY2024 figures only
  const later = cli(["scout", "--mandate", w.mandateFile, "--home", w.home, "--facts-dir", w.factsDir, "--as-of", "2025-06-01"]);
  assert.equal(later.code, 0, later.err + later.out);
  assert.equal(read().cards.length, 1);
  assert.equal(read().cards[0].asOf, "2024-12-31", "the FY2025 report, filed in 2026, cannot influence a 2025 screen");
  assert.ok(read().cards[0].whyPassed.some((l: { text: string }) => /operating margin was 30%/.test(l.text)));
});

test("scout twice on the same day reuses its checkpoints and changes nothing", () => {
  const w = workspace();
  cli(["scout", "--mandate", w.mandateFile, "--home", w.home, "--facts-dir", w.factsDir]);
  const again = cli(["scout", "--mandate", w.mandateFile, "--home", w.home, "--facts-dir", w.factsDir]);
  assert.equal(again.code, 0);
  assert.match(again.out, /\(reused\)/);
});

test("calls: registered before the outcome, refused when malformed, unresolvable early, and no accuracy below the floor", () => {
  const w = workspace();
  const reg = cli(["calls", "register", "--claim", "STRONG keeps its operating margin at or above 20% in the FY2026 report", "--p", "0.7", "--resolves", "2099-08-01", "--source", "Form 10-K FY2026 on SEC EDGAR", "--home", w.home]);
  assert.equal(reg.code, 0, reg.err);
  assert.match(reg.out, /cannot be edited or back-dated/);
  const id = /registered (\w+) at/.exec(reg.out)?.[1] as string;
  assert.ok(id);
  const certain = cli(["calls", "register", "--claim", "x", "--p", "1", "--resolves", "2099-08-01", "--source", "somewhere", "--home", w.home]);
  assert.equal(certain.code, 1);
  assert.match(certain.err, /not forecasts/);
  const past = cli(["calls", "register", "--claim", "x", "--p", "0.5", "--resolves", "2001-01-01", "--source", "somewhere", "--home", w.home]);
  assert.equal(past.code, 1);
  assert.match(past.err, /in the future/);
  const early = cli(["calls", "resolve", id, "--outcome", "1", "--home", w.home]);
  assert.equal(early.code, 1);
  assert.match(early.err, /cannot be resolved before 2099-08-01/);
  assert.ok(!cli(["calls", "list", "--home", w.home]).out.includes("20%"), "free-form forecast text is withheld");
  assert.match(cli(["calls", "due", "--home", w.home]).out, /nothing is due/);
  const score = JSON.parse(cli(["calls", "score", "--home", w.home]).out);
  assert.equal(score.open, 1);
  assert.equal(score.brier, undefined);
  assert.match(score.note, /sample floor/);
});
