import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceLedger } from "../src/ledger.ts";
import { extractPayload } from "../src/sec.ts";
import { EXAMPLE_MANDATE } from "../src/mandate.ts";
import { scoutWorkflow, RulesSkeptic, SCOUT_RECOMPUTE } from "../src/scout.ts";
import { RulesVerifier } from "../src/today.ts";
import { runWorkflow, WorkflowStore } from "../src/graph.ts";
import { loadPolicyTable } from "../src/contracts.ts";
import { priceDatum } from "../src/prices.ts";
test("value style runs end to end with audited price and EPS evidence", async () => {
  const annual = (val: number, year: number) => ({
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    filed: `${year + 1}-02-15`,
    form: "10-K",
    val,
  });
  const extraction = extractPayload(
    {
      cik: 1,
      entityName: "DEMO",
      facts: {
        "us-gaap": {
          Revenues: { units: { USD: [annual(100, 2025), annual(90, 2024)] } },
          EarningsPerShareDiluted: {
            units: { "USD/shares": [annual(2.5, 2025)] },
          },
        },
      },
    },
    "DEMO",
    { asOf: "2026-09-30" },
  );
  assert.ok(extraction.ok);
  const now = () => new Date("2026-09-30T23:59:59Z");
  const ledger = new EvidenceLedger();
  const store = new WorkflowStore();
  const report = await runWorkflow(scoutWorkflow(), {
    store,
    runId: "value",
    ctx: {
      ledger,
      table: loadPolicyTable(),
      mandate: {
        ...EXAMPLE_MANDATE,
        styles: ["value"],
        thresholds: { maxAnnualEarningsMultiple: 12 },
        watchlist: [{ ticker: "DEMO" }],
      },
      sec: {
        fetchFundamentals: async () => ({
          ok: true,
          datum: {
            provider: "fixture",
            url: "fixture://earnings",
            asOf: "2025-12-31",
            retrievedAt: now().toISOString(),
            licenceClass: "sim_only",
            delayedBySeconds: 0,
            payload: extraction.payload,
          },
        }),
      },
      prices: {
        fetchPrice: async () =>
          priceDatum(
            {
              ticker: "DEMO",
              currency: "USD",
              basis: "unadjusted",
              epsBasisVerified: true,
              sourceUrl: "https://example.test/prices",
              licenceClass: "sim_only",
              licenceUrl: "https://example.test/fixture-terms",
              observations: [
                {
                  date: "2026-09-29",
                  availableAt: "2026-09-29T21:00:00Z",
                  close: 25,
                },
              ],
            },
            "DEMO",
            now().toISOString(),
            now().toISOString(),
          ),
      },
      writer: { provider: "template" },
      skeptic: new RulesSkeptic(),
      verifier: new RulesVerifier(SCOUT_RECOMPUTE),
      displayContext: "local_user",
      asOf: "2026-09-30",
      now,
    },
  });
  assert.equal(report.status, "completed", JSON.stringify(report.nodes));
  const output = report.nodes.publish?.output as any;
  assert.equal(output.json.cards[0].style, "value");
  assert.ok(
    output.json.cards[0].whyPassed.some((l: any) =>
      l.text.includes("Annual earnings multiple was 10"),
    ),
  );
  assert.ok(output.json.cards[0].scoreClaimId);
  assert.ok(output.json.screen.claimIds.length);
  store.close();
  ledger.close();
});
