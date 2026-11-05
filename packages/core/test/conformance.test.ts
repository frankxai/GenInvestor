import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validate } from "../../contracts/src/validate.ts";
import type { Schema } from "../../contracts/src/validate.ts";
import { loadPolicyTable } from "../src/contracts.ts";
import { runWorkflow, WorkflowStore } from "../src/graph.ts";
import { EvidenceLedger } from "../src/ledger.ts";
import { EcbProvider, parseSdmxJson } from "../src/providers.ts";
import type { FetchLike } from "../src/providers.ts";
import { RulesVerifier, TemplateAnalyst, todayWorkflow } from "../src/today.ts";

const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../contracts/schemas/${name}.schema.json`, import.meta.url), "utf8")) as Schema;
const ecb = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ecb/${name}.json`, import.meta.url), "utf8"));

const fetchFixture: FetchLike = async (url) => {
  const name = url.includes("/EXR/") ? "eurusd" : url.includes("/EST/") ? "estr" : url.includes("/ICP/") ? "hicp" : "dfr";
  return { ok: true, status: 200, json: async () => ecb(name) };
};

test("everything the ECB provider returns conforms to the datum contract", async () => {
  for (const id of ["EXR.USD", "EST.ESTR", "ICP.HICP_ANR", "FM.DFR"]) {
    const datum = await new EcbProvider(fetchFixture, () => new Date("2026-09-30T03:40:00Z")).fetchSeries(id);
    assert.deepEqual(validate(schema("datum"), datum), [], id);
  }
});

test("every claim in a real run conforms to the claim contract, and the brief.json to the brief contract", async () => {
  const ledger = new EvidenceLedger();
  const report = await runWorkflow(todayWorkflow(), {
    store: new WorkflowStore(),
    runId: "conf",
    ctx: {
      ledger,
      table: loadPolicyTable(),
      provider: new EcbProvider(fetchFixture, () => new Date("2026-09-30T03:40:00Z")),
      analyst: new TemplateAnalyst(),
      verifier: new RulesVerifier(),
      watchlist: ["EXR.USD", "EST.ESTR", "ICP.HICP_ANR", "FM.DFR"],
      theses: [],
      displayContext: "local_user",
      now: () => new Date("2026-09-30T03:40:00Z"),
    },
  });
  assert.equal(report.status, "completed", JSON.stringify(report.nodes));

  const rows = ledger.db.prepare("SELECT id FROM claims").all() as { id: string }[];
  assert.equal(rows.length, 4);
  for (const { id } of rows) {
    const c = ledger.getClaim(id);
    assert.ok(c);
    const asContract = { text: c.text, kind: c.kind, producedBy: c.producedBy, runId: c.runId, confidence: c.confidence, links: c.links.map(({ sourceId, kind, fieldOrQuote, value }) => ({ sourceId, kind, fieldOrQuote, value })) };
    assert.deepEqual(validate(schema("claim"), asContract), [], c.text);
  }

  const json = (report.nodes.publish?.output as { json: unknown }).json;
  assert.deepEqual(validate(schema("brief"), json), []);
});

test("parsing a real response and the contract agree on shape for all four catalogued series", () => {
  for (const name of ["eurusd", "estr", "hicp", "dfr"]) {
    const p = parseSdmxJson(name, ecb(name));
    assert.ok(p.latest.date && Number.isFinite(p.latest.value));
  }
});
