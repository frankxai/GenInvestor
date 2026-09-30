import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkMandate, DEFAULT_THRESHOLDS, effectiveThresholds, EXAMPLE_MANDATE, loadMandate, mandateFingerprint } from "../src/mandate.ts";
import type { Mandate } from "../src/mandate.ts";

const clone = (over: Record<string, unknown> = {}) => ({ ...JSON.parse(JSON.stringify(EXAMPLE_MANDATE)), ...over });

test("the example mandate is valid, so the documented starting point cannot rot", () => {
  const r = checkMandate(EXAMPLE_MANDATE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test("schema mistakes are reported with the path", () => {
  assert.ok(checkMandate(clone({ horizonYears: 0 })).errors.some((e) => /horizonYears/.test(e)));
  assert.ok(checkMandate(clone({ riskTolerance: "yolo" })).errors.some((e) => /riskTolerance/.test(e)));
  assert.ok(checkMandate(clone({ styles: [] })).errors.some((e) => /styles/.test(e)));
  assert.ok(checkMandate(clone({ watchlist: [{ ticker: "lower" }] })).errors.some((e) => /watchlist/.test(e)));
  assert.ok(checkMandate(clone({ surprise: true })).errors.some((e) => /unexpected property "surprise"/.test(e)));
  const { name: _omit, ...noName } = clone();
  assert.ok(checkMandate(noName).errors.some((e) => /missing required "name"/.test(e)));
});

test("rules a schema cannot express: duplicates, excluded tickers on the watchlist, limits out of order", () => {
  assert.ok(checkMandate(clone({ watchlist: [{ ticker: "A" }, { ticker: "A" }] })).errors.some((e) => /duplicate/.test(e)));
  assert.ok(checkMandate(clone({ exclusions: { tickers: ["MSFT"] } })).errors.some((e) => /excluded tickers: MSFT/.test(e)));
  assert.ok(checkMandate(clone({ limits: { maxPositionPct: 30, maxSectorPct: 10 } })).errors.some((e) => /cannot exceed/.test(e)));
});

test("styles and markets that cannot be served yet produce warnings, not silence", () => {
  const r = checkMandate(clone({ styles: ["value", "special-situation"], markets: ["us-equities", "crypto"] }));
  assert.equal(r.valid, true);
  assert.equal(r.warnings.length, 3);
});

test("thresholds default sensibly and the owner's values win", () => {
  assert.deepEqual(effectiveThresholds({ ...EXAMPLE_MANDATE, thresholds: undefined } as Mandate), DEFAULT_THRESHOLDS);
  assert.equal(effectiveThresholds(EXAMPLE_MANDATE).minOperatingMarginPct, 20);
});

test("the fingerprint tracks the screen rules and reveals neither holdings, exclusions nor the watchlist", () => {
  const a = mandateFingerprint(EXAMPLE_MANDATE);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(mandateFingerprint({ ...EXAMPLE_MANDATE, holdings: ["SECRETCO"], watchlist: [{ ticker: "ZZZ" }], exclusions: { tickers: ["BAD"] } }), a);
  assert.notEqual(mandateFingerprint({ ...EXAMPLE_MANDATE, thresholds: { minOperatingMarginPct: 25 } }), a);
  assert.notEqual(mandateFingerprint({ ...EXAMPLE_MANDATE, styles: ["growth"] }), a);
});

test("loadMandate reports unreadable and malformed files instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-"));
  assert.match(loadMandate(join(dir, "missing.json")).errors[0] ?? "", /cannot read/);
  writeFileSync(join(dir, "bad.json"), "{ not json");
  assert.match(loadMandate(join(dir, "bad.json")).errors[0] ?? "", /cannot read/);
  writeFileSync(join(dir, "ok.json"), JSON.stringify(EXAMPLE_MANDATE));
  assert.equal(loadMandate(join(dir, "ok.json")).valid, true);
});
