import assert from "node:assert/strict";
import { test } from "node:test";
import { priceDatum, annualEarningsMultiple } from "../src/prices.ts";
const record = {
  ticker: "DEMO",
  currency: "USD",
  basis: "unadjusted" as const,
  licenceClass: "user_licensed" as const,
  licenceUrl: "https://example.test/user-data-terms",
  sourceUrl: "https://example.test/prices/DEMO",
  observations: [
    { date: "2026-09-29", availableAt: "2026-09-29T21:00:00Z", close: 25 },
    { date: "2026-09-30", availableAt: "2026-10-01T01:00:00Z", close: 30 },
  ],
  epsBasisVerified: true,
};
test("price cutoff uses availability time, not bar date", () => {
  const d = priceDatum(
    record,
    "DEMO",
    "2026-09-30T23:59:59Z",
    "2026-10-01T02:00:00Z",
  );
  assert.equal((d.payload as any).latest.close, 25);
  assert.equal(d.licenceClass, "user_licensed");
});
test("bad numbers, unknown rights, ambiguous basis and ticker mismatches fail closed", () => {
  for (const input of [
    { ...record, licenceUrl: "" },
    { ...record, ticker: "OTHER" },
    {
      ...record,
      observations: [{ ...record.observations[0], date: "2026-02-30" }],
    },
    { ...record, basis: "adjusted" },
    { ...record, observations: [{ ...record.observations[0], close: NaN }] },
  ])
    assert.throws(() =>
      priceDatum(input, "DEMO", "2026-10-01T02:00:00Z", "2026-10-01T02:00:00Z"),
    );
});
test("annual earnings multiple requires positive EPS and verified compatible share basis", () => {
  const d = priceDatum(
    record,
    "DEMO",
    "2026-09-30T23:59:59Z",
    "2026-10-01T02:00:00Z",
  );
  assert.equal(annualEarningsMultiple(d, 2.5), 10);
  assert.throws(() => annualEarningsMultiple(d, 0));
  assert.throws(() =>
    annualEarningsMultiple(
      { ...d, payload: { ...(d.payload as object), epsBasisVerified: false } },
      2.5,
    ),
  );
});
