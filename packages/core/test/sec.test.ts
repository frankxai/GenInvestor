import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { extractPayload, metricsOf, SEC_RECOMPUTE, SecProvider } from "../src/sec.ts";
import type { SecPayload } from "../src/sec.ts";
import type { FetchLike } from "../src/providers.ts";

const snow = JSON.parse(readFileSync(new URL("./fixtures/sec/snow_facts.trimmed.json", import.meta.url), "utf8"));

test("real Snowflake data: repeated restated years are deduplicated and the fiscal year is not the calendar year", () => {
  const x = extractPayload(snow, "SNOW");
  assert.equal(x.ok, true);
  const p = (x as { payload: SecPayload }).payload;
  assert.equal(p.cik, "0001640147");
  assert.equal(p.name, "SNOWFLAKE INC.");
  assert.equal(p.revenueTag, "RevenueFromContractWithCustomerExcludingAssessedTax");
  assert.deepEqual(p.revenue.map((r) => r.end), ["2025-01-31", "2024-01-31", "2023-01-31"], "one point per year end, newest first");
  assert.equal(new Set(p.revenue.map((r) => r.end)).size, p.revenue.length);
  assert.equal(p.revenue[0]?.filed, "2025-03-21", "the latest filing wins for a repeated year");
  assert.equal(p.revenue[2]?.filed, "2025-03-21");
});

test("real Snowflake metrics match hand calculation from the SEC figures", () => {
  const p = (extractPayload(snow, "SNOW") as { payload: SecPayload }).payload;
  const m = metricsOf(p);
  assert.equal(m.fiscalYearEnd, "2025-01-31");
  assert.equal(m.revenue, 3626396000);
  assert.equal(m.priorRevenue, 2806489000);
  assert.equal(m.revenueGrowthPct, 29.21); // 3626396 / 2806489 - 1
  assert.equal(m.operatingMarginPct, -40.15); // -1456010 / 3626396
  assert.equal(m.liabilitiesToEquity, 2.01); // 6027295 / 2999929
  assert.equal(m.negativeEquity, false);
});

test("recompute functions reproduce the metrics from the stored payload alone", () => {
  const p = (extractPayload(snow, "SNOW") as { payload: SecPayload }).payload;
  assert.equal(SEC_RECOMPUTE.revenue_growth_pct?.(p), 29.21);
  assert.equal(SEC_RECOMPUTE.operating_margin_pct?.(p), -40.15);
  assert.equal(SEC_RECOMPUTE.liabilities_to_equity?.(p), 2.01);
});

test("a payload survives a JSON round trip unchanged, which is what the ledger stores", () => {
  const p = (extractPayload(snow, "SNOW") as { payload: SecPayload }).payload;
  assert.deepEqual(metricsOf(JSON.parse(JSON.stringify(p))), metricsOf(p));
});

test("companies that cannot be screened say why instead of producing numbers", () => {
  assert.match((extractPayload({ cik: 1, entityName: "X", facts: {} }, "X") as { reason: string }).reason, /no US-GAAP/);
  const oneYear = { cik: 1, entityName: "X", facts: { "us-gaap": { Revenues: { units: { USD: [{ start: "2024-01-01", end: "2024-12-31", val: 5, form: "10-K", fp: "FY", filed: "2025-02-01" }] } } } } };
  assert.match((extractPayload(oneYear, "X") as { reason: string }).reason, /fewer than two annual/);
  assert.equal(extractPayload(null, "X").ok, false);
});

test("quarterly entries inside a 10-K, and non-annual reports, are never mistaken for full years", () => {
  const facts = {
    cik: 9, entityName: "Y",
    facts: { "us-gaap": { Revenues: { units: { USD: [
      { start: "2024-01-01", end: "2024-12-31", val: 400, form: "10-K", fp: "FY", filed: "2025-02-01" },
      { start: "2023-01-01", end: "2023-12-31", val: 300, form: "10-K", fp: "FY", filed: "2025-02-01" },
      { start: "2024-10-01", end: "2024-12-31", val: 110, form: "10-K", fp: "FY", filed: "2025-02-01" }, // fourth quarter shown in the 10-K
      { start: "2024-01-01", end: "2024-09-30", val: 290, form: "10-Q", fp: "Q3", filed: "2024-11-01" },
    ] } } } },
  };
  const p = (extractPayload(facts, "Y") as { payload: SecPayload }).payload;
  assert.deepEqual(p.revenue.map((r) => r.val), [400, 300]);
  assert.equal(metricsOf(p).revenueGrowthPct, 33.33);
});

test("negative equity is flagged and leverage is not computed from it", () => {
  const p: SecPayload = {
    cik: "1", ticker: "Z", name: "Z", revenueTag: "Revenues",
    revenue: [{ end: "2025-12-31", val: 200, filed: "2026-02-01", form: "10-K" }, { end: "2024-12-31", val: 100, filed: "2026-02-01", form: "10-K" }],
    operatingIncome: [{ end: "2025-12-31", val: 50, filed: "2026-02-01", form: "10-K" }],
    netIncome: [],
    liabilities: [{ end: "2025-12-31", val: 500, filed: "2026-02-01", form: "10-K" }],
    equity: [{ end: "2025-12-31", val: -20, filed: "2026-02-01", form: "10-K" }],
  };
  const m = metricsOf(p);
  assert.equal(m.negativeEquity, true);
  assert.equal(m.liabilitiesToEquity, null);
  assert.equal(m.operatingMarginPct, 25);
  assert.throws(() => SEC_RECOMPUTE.liabilities_to_equity?.(p), /no usable balance sheet/);
});

test("the provider refuses to run without a contact identity", () => {
  assert.throws(() => new SecProvider({ identity: "" }), /contact identity/);
  assert.throws(() => new SecProvider({ identity: "just a name" }), /contact identity/);
  assert.doesNotThrow(() => new SecProvider({ identity: "Alex Example alex@example.org" }));
});

function fakeSec(log: { url: string; ua: string | undefined }[] = [], status = 200): FetchLike {
  return async (url, init) => {
    log.push({ url, ua: init?.headers?.["User-Agent"] });
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    if (url.endsWith("company_tickers.json")) return { ok: true, status: 200, json: async () => ({ "0": { cik_str: 1640147, ticker: "SNOW", title: "Snowflake" } }) };
    if (url.includes("/companyfacts/CIK0001640147.json")) return { ok: true, status: 200, json: async () => snow };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("the provider identifies itself on every request, resolves tickers once, and returns a public datum", async () => {
  const log: { url: string; ua: string | undefined }[] = [];
  const sec = new SecProvider({ identity: "Alex Example alex@example.org", fetchImpl: fakeSec(log), sleep: async () => {}, now: () => new Date("2026-09-30T10:00:00Z") });
  const r = await sec.fetchFundamentals("snow");
  assert.equal(r.ok, true);
  const datum = (r as { datum: { provider: string; asOf: string; licenceClass: string; url: string; retrievedAt: string } }).datum;
  assert.equal(datum.provider, "sec-edgar");
  assert.equal(datum.asOf, "2025-01-31");
  assert.equal(datum.licenceClass, "public");
  assert.equal(datum.retrievedAt, "2026-09-30T10:00:00.000Z");
  assert.match(datum.url, /companyfacts\/CIK0001640147\.json$/);
  await sec.fetchFundamentals("SNOW");
  assert.equal(log.filter((l) => l.url.endsWith("company_tickers.json")).length, 1, "ticker list fetched once");
  assert.ok(log.every((l) => l.ua === "Alex Example alex@example.org"));
});

test("a cik hint skips the ticker lookup, and an unknown ticker fails clearly", async () => {
  const log: { url: string; ua: string | undefined }[] = [];
  const sec = new SecProvider({ identity: "a b@c.de", fetchImpl: fakeSec(log), sleep: async () => {} });
  await sec.fetchFundamentals("SNOW", "1640147");
  assert.ok(!log.some((l) => l.url.endsWith("company_tickers.json")));
  await assert.rejects(sec.fetchFundamentals("NOPE"), /not in the SEC ticker list/);
});

test("SEC refusals are explained, not retried blindly", async () => {
  const sec = new SecProvider({ identity: "a b@c.de", fetchImpl: fakeSec([], 403), sleep: async () => {} });
  await assert.rejects(sec.fetchFundamentals("SNOW", "1640147"), /SEC refused the request \(HTTP 403\)/);
});

test("requests are spaced out to stay far under the SEC rate limit", async () => {
  const waits: number[] = [];
  const sec = new SecProvider({ identity: "a b@c.de", fetchImpl: fakeSec(), sleep: async (ms) => { waits.push(ms); }, minIntervalMs: 200 });
  await sec.fetchFundamentals("SNOW", "1640147");
  await sec.fetchFundamentals("SNOW", "1640147");
  assert.ok(waits.length >= 1 && waits.every((w) => w > 0 && w <= 200));
});

test("live SEC smoke test (opt in with GENINVESTOR_LIVE=1 and GENINVESTOR_SEC_IDENTITY)", { skip: process.env.GENINVESTOR_LIVE !== "1" || !process.env.GENINVESTOR_SEC_IDENTITY }, async () => {
  const sec = new SecProvider({ identity: process.env.GENINVESTOR_SEC_IDENTITY as string });
  const r = await sec.fetchFundamentals("MSFT");
  assert.equal(r.ok, true);
  const m = metricsOf(((r as { datum: { payload: SecPayload } }).datum).payload);
  assert.ok(m.revenue > 1e10, "Microsoft's annual revenue is far above $10 billion");
});
