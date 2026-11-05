import assert from "node:assert/strict";
import { test } from "node:test";
import { BAND_FLOOR, CalibrationLedger, SAMPLE_FLOOR } from "../src/calibration.ts";
import type { CallInput } from "../src/calibration.ts";

function clock(start = "2026-01-01T09:00:00Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t), advanceDays: (d: number) => { t += d * 86_400_000; } };
}
const call = (over: Partial<CallInput> = {}): CallInput => ({
  claim: "Company X reports revenue growth above 12% for FY2026",
  probability: 0.7,
  resolvesOn: "2026-06-30",
  resolutionSource: "Form 10-K, revenue line, fiscal 2026",
  ...over,
});

test("registration stamps the ledger's own time and requires a resolvable, future, well-formed call", () => {
  const c = clock();
  const l = new CalibrationLedger(":memory:", c.now);
  const row = l.register(call());
  assert.equal(row.registeredAt, "2026-01-01T09:00:00.000Z");
  assert.equal(row.outcome, null);
  assert.throws(() => l.register(call({ claim: "  " })), /claim/);
  assert.throws(() => l.register(call({ probability: 1 })), /not forecasts/);
  assert.throws(() => l.register(call({ probability: 0 })), /not forecasts/);
  assert.throws(() => l.register(call({ probability: 1.5 })), /between/);
  assert.throws(() => l.register(call({ resolvesOn: "next spring" })), /YYYY-MM-DD/);
  assert.throws(() => l.register(call({ resolvesOn: "2026-01-01" })), /in the future/);
  assert.throws(() => l.register(call({ resolvesOn: "2025-12-31" })), /in the future/);
  assert.throws(() => l.register(call({ resolutionSource: "" })), /resolution source/);
  assert.throws(() => l.register(call({ baseline: 1.2 })), /baseline/);
});

test("entries and resolutions cannot be edited or deleted: the database refuses", () => {
  const c = clock();
  const l = new CalibrationLedger(":memory:", c.now);
  const row = l.register(call());
  assert.throws(() => l.db.exec(`UPDATE calls SET probability = 0.99 WHERE id = '${row.id}'`), /append-only/);
  assert.throws(() => l.db.exec(`DELETE FROM calls WHERE id = '${row.id}'`), /append-only/);
  c.advanceDays(200);
  l.resolve(row.id, 0);
  assert.throws(() => l.db.exec(`UPDATE resolutions SET outcome = 1 WHERE call_id = '${row.id}'`), /append-only/);
  assert.throws(() => l.db.exec(`DELETE FROM resolutions WHERE call_id = '${row.id}'`), /append-only/);
});

test("a call cannot be resolved early, twice, or with a made-up outcome", () => {
  const c = clock();
  const l = new CalibrationLedger(":memory:", c.now);
  const row = l.register(call());
  assert.throws(() => l.resolve(row.id, 1), /cannot be resolved before 2026-06-30/);
  c.advanceDays(180);
  assert.throws(() => l.resolve(row.id, 2 as 1), /outcome must be 0/);
  assert.equal(l.resolve(row.id, 1, "revenue +13%").outcome, 1);
  assert.throws(() => l.resolve(row.id, 0), /already resolved/);
  assert.throws(() => l.resolve("nope", 1), /no call/);
});

test("due() lists exactly the calls whose date has arrived and that are still open", () => {
  const c = clock();
  const l = new CalibrationLedger(":memory:", c.now);
  const early = l.register(call({ resolvesOn: "2026-02-01" }));
  l.register(call({ claim: "later one", resolvesOn: "2026-12-01" }));
  assert.deepEqual(l.due(), []);
  c.advanceDays(40);
  assert.deepEqual(l.due().map((x) => x.id), [early.id]);
  l.resolve(early.id, 1);
  assert.deepEqual(l.due(), []);
});

test("below the sample floor no accuracy figure exists at all, only counts", () => {
  const c = clock();
  const l = new CalibrationLedger(":memory:", c.now);
  for (let i = 0; i < SAMPLE_FLOOR - 1; i++) l.register(call({ claim: `call ${i}`, resolvesOn: "2026-02-01" }));
  c.advanceDays(40);
  for (const d of l.due()) l.resolve(d.id, 1);
  const s = l.score();
  assert.equal(s.resolved, SAMPLE_FLOOR - 1);
  assert.equal(s.brier, undefined);
  assert.equal(s.baselineBrier, undefined);
  assert.equal(s.reliability, undefined);
  assert.match(s.note ?? "", /sample floor/);
});

function ledgerWith(outcomes: { p: number; o: 0 | 1 }[]) {
  const c = clock();
  const l = new CalibrationLedger(":memory:", c.now);
  outcomes.forEach((x, i) => l.register(call({ claim: `c${i}`, probability: x.p, resolvesOn: "2026-02-01" })));
  c.advanceDays(40);
  const due = l.due();
  due.forEach((d, i) => l.resolve(d.id, outcomes[Number(d.claim.slice(1))]!.o));
  return l;
}

test("at the floor, Brier and the baseline are computed correctly", () => {
  // 30 calls at 0.8: 24 happen, 6 do not. Brier = (24*0.04 + 6*0.64)/30 = 0.16. Base rate 0.8, baseline = 0.16
  const outcomes = Array.from({ length: 30 }, (_, i) => ({ p: 0.8, o: (i < 24 ? 1 : 0) as 0 | 1 }));
  const s = ledgerWith(outcomes).score();
  assert.equal(s.brier, 0.16);
  assert.equal(s.baselineBrier, 0.16);
  assert.equal(s.reliability?.length, 1);
  assert.deepEqual(s.reliability?.[0], { band: "80-89%", n: 30, stated: 0.8, observed: 0.8 });
});

test("overconfidence shows up: a well-calibrated forecaster beats one who says 95% and is right half the time", () => {
  const overconfident = Array.from({ length: 30 }, (_, i) => ({ p: 0.95, o: (i % 2) as 0 | 1 }));
  const calibrated = Array.from({ length: 30 }, (_, i) => ({ p: 0.5, o: (i % 2) as 0 | 1 }));
  const a = ledgerWith(overconfident).score();
  const b = ledgerWith(calibrated).score();
  assert.ok((a.brier as number) > (b.brier as number));
  assert.equal(a.reliability?.[0]?.stated, 0.95);
  assert.equal(a.reliability?.[0]?.observed, 0.5);
});

test("reliability bands below the band floor are not shown", () => {
  const outcomes = [
    ...Array.from({ length: 25 }, (_, i) => ({ p: 0.7, o: (i % 2) as 0 | 1 })),
    ...Array.from({ length: BAND_FLOOR - 1 }, () => ({ p: 0.2, o: 0 as 0 | 1 })),
  ];
  const s = ledgerWith(outcomes).score();
  assert.equal(s.resolved, 25 + BAND_FLOOR - 1);
  assert.deepEqual(s.reliability?.map((b) => b.band), ["70-79%"]);
});

test("the ledger works from a file and survives reopening", () => {
  const c = clock();
  const dir = `${process.env.TMPDIR ?? process.env.TEMP ?? "."}/gi-cal-${process.pid}.db`;
  const a = new CalibrationLedger(dir, c.now);
  const row = a.register(call());
  a.close();
  const b = new CalibrationLedger(dir, c.now);
  assert.equal(b.get(row.id)?.claim, row.claim);
  b.close();
});
