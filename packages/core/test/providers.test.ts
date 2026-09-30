import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EcbProvider, ECB_SERIES, parseSdmxJson } from "../src/providers.ts";
import type { FetchLike } from "../src/providers.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ecb/${name}.json`, import.meta.url), "utf8"));

test("parses a real recorded ECB response into ascending observations with latest and prior", () => {
  const p = parseSdmxJson("EXR.USD", fixture("eurusd"));
  assert.equal(p.observations.length, 3);
  assert.deepEqual(p.observations.map((o) => o.date), [...p.observations.map((o) => o.date)].sort());
  assert.equal(p.latest.date, p.observations[2]?.date);
  assert.equal(p.prior?.date, p.observations[1]?.date);
  assert.equal(p.unit, "USD");
  assert.match(p.label, /US dollar\/Euro/);
});

test("every catalogued series has a recorded fixture that parses to numbers", () => {
  const fixtures: Record<string, string> = { "EXR.USD": "eurusd", "EST.ESTR": "estr", "ICP.HICP_ANR": "hicp", "FM.DFR": "dfr" };
  assert.deepEqual(Object.keys(ECB_SERIES).sort(), Object.keys(fixtures).sort());
  for (const [id, file] of Object.entries(fixtures)) {
    const p = parseSdmxJson(id, fixture(file));
    assert.ok(Number.isFinite(p.latest.value), `${id} latest is a number`);
  }
});

test("EcbProvider builds the documented URL, stamps as-of from the data, and marks it public", async () => {
  let called = "";
  const fetchImpl: FetchLike = async (url) => {
    called = url;
    return { ok: true, status: 200, json: async () => fixture("eurusd") };
  };
  const datum = await new EcbProvider(fetchImpl, () => new Date("2026-09-30T06:00:00Z")).fetchSeries("EXR.USD");
  assert.match(called, /data-api\.ecb\.europa\.eu\/service\/data\/EXR\/D\.USD\.EUR\.SP00\.A\?lastNObservations=3&format=jsondata/);
  assert.equal(datum.licenceClass, "public");
  assert.equal(datum.retrievedAt, "2026-09-30T06:00:00.000Z");
  assert.equal(datum.asOf, (datum.payload as { latest: { date: string } }).latest.date);
});

test("HTTP errors, empty responses and unknown series fail loudly", async () => {
  const bad: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(new EcbProvider(bad).fetchSeries("EXR.USD"), /HTTP 503/);
  const empty: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ dataSets: [{ series: {} }], structure: { dimensions: { observation: [{ values: [] }] } } }) });
  await assert.rejects(new EcbProvider(empty).fetchSeries("EXR.USD"), /no series/);
  await assert.rejects(new EcbProvider().fetchSeries("NOPE"), /Unknown ECB series/);
});

test("live smoke test against the real ECB API (opt in with GENINVESTOR_LIVE=1)", { skip: process.env.GENINVESTOR_LIVE !== "1" }, async () => {
  const datum = await new EcbProvider().fetchSeries("EXR.USD");
  const payload = datum.payload as { latest: { value: number } };
  assert.ok(payload.latest.value > 0.5 && payload.latest.value < 2.5, "EUR/USD is in a sane range");
});
