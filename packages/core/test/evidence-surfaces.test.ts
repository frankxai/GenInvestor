import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLedger } from "../src/ledger.ts";
import { evidenceFigure } from "../src/view.ts";
import { ownershipClaims } from "../src/ownership.ts";
import { runDailyScan, reviewDailyScan } from "../src/daily.ts";
import { EXAMPLE_MANDATE } from "../src/mandate.ts";
test("evidence drawer rejects unsupported figures and restricted sources", () => {
  const l = new EvidenceLedger();
  const s = l.addSource({
    provider: "fixture",
    url: "fixture://source",
    asOf: "2026-09-30",
    retrievedAt: "2026-10-01T00:00:00Z",
    licenceClass: "restricted",
    delayedBySeconds: 0,
    payload: { value: 12 },
  });
  const c = l.addClaim({
    text: "Value 12",
    kind: "fact",
    producedBy: "fixture",
    runId: "r",
    links: [
      { sourceId: s.id, kind: "field", fieldOrQuote: "value", value: 12 },
    ],
  });
  assert.equal(
    evidenceFigure({ text: c.text, claimIds: [c.id] }, l, {
      context: "public",
    }),
    undefined,
  );
  assert.equal(
    evidenceFigure({ text: "Value 13", claimIds: [c.id] }, l, {
      context: "local_user",
    }),
    undefined,
  );
  const allowed = l.addSource({ ...s, licenceClass: "user_licensed" });
  const ok = l.addClaim({
    text: "Value 12",
    kind: "fact",
    producedBy: "fixture",
    runId: "allowed",
    links: [
      { sourceId: allowed.id, kind: "field", fieldOrQuote: "value", value: 12 },
    ],
  });
  const figure = evidenceFigure({ text: ok.text, claimIds: [ok.id] }, l, {
    context: "local_user",
  });
  assert.equal(figure?.receipts[0].sources[0].sha256, s.sha256);
  assert.ok(!JSON.stringify(figure).includes("confidence"));
  l.close();
});
test("ownership figures retain row and source identity and obey display rights", () => {
  const l = new EvidenceLedger();
  const d = {
    provider: "fixture",
    url: "fixture://form4",
    asOf: "2026-09-28",
    retrievedAt: "2026-10-01T00:00:00Z",
    licenceClass: "restricted" as const,
    delayedBySeconds: 0,
    payload: {
      form: "4",
      transactions: [{ code: "F", shares: 25, price: null }],
    },
  };
  assert.throws(() => ownershipClaims(l, d, "public"), /audit/);
  const lines = ownershipClaims(
    l,
    { ...d, licenceClass: "user_licensed" },
    "local_user",
  );
  assert.equal(lines.length, 1);
  assert.equal(
    l.explain(lines[0].claimIds[0])?.sources[0].link.fieldOrQuote,
    "transactions.0.shares",
  );
  l.close();
});
test("daily scan requires explicit live consent and stops at human review; mutated staged data cannot pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "gi-daily-"));
  const home = join(root, "home");
  mkdirSync(join(root, "facts"));
  writeFileSync(
    join(root, "mandate.json"),
    JSON.stringify({ ...EXAMPLE_MANDATE, watchlist: [{ ticker: "MISSING" }] }),
  );
  const config = {
    mandate: "mandate.json",
    factsDir: "facts",
    asOf: "2026-09-30",
  };
  await assert.rejects(
    runDailyScan({ ...config, factsDir: undefined }, { home, baseDir: root }),
    /explicitly/,
  );
  const result = await runDailyScan(config, { home, baseDir: root });
  assert.equal(result.status, "waiting_human");
  assert.ok(!existsSync(join(home, "opportunities", "opportunities.json")));
  const reviewed = reviewDailyScan(home, result.runId);
  assert.equal(reviewed.status, "owner-reviewed");
  assert.equal(
    JSON.parse(
      readFileSync(join(home, "opportunities", "opportunities.json"), "utf8"),
    ).cards.length,
    0,
  );
  writeFileSync(join(result.reviewPath, "opportunities.md"), "invented");
  assert.throws(() => reviewDailyScan(home, result.runId), /integrity/);
});
