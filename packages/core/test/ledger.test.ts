import assert from "node:assert/strict";
import { test } from "node:test";
import { canDisplay, EvidenceLedger, getPath } from "../src/ledger.ts";
import type { Datum } from "../src/ledger.ts";

const datum = (over: Partial<Datum> = {}): Datum => ({
  provider: "fixture",
  url: "fixture://eurusd",
  asOf: "2026-09-29",
  retrievedAt: "2026-09-30T06:00:00Z",
  licenceClass: "public",
  delayedBySeconds: 0,
  payload: { series: "EURUSD", value: 1.085, note: "close" },
  ...over,
});

test("a claim needs at least one link, and links must point at stored sources", () => {
  const ledger = new EvidenceLedger();
  assert.throws(() => ledger.addClaim({ text: "x", kind: "fact", producedBy: "t", runId: "r", links: [] }), /at least one link/);
  assert.throws(
    () => ledger.addClaim({ text: "x", kind: "fact", producedBy: "t", runId: "r", links: [{ sourceId: "nope", kind: "field", fieldOrQuote: "a" }] }),
    /Unknown source/,
  );
});

test("ids are content hashes: adding the same source or claim twice is a no-op", () => {
  const ledger = new EvidenceLedger();
  const a = ledger.addSource(datum());
  const b = ledger.addSource(datum());
  assert.equal(a.id, b.id);
  const link = { sourceId: a.id, kind: "field" as const, fieldOrQuote: "value", value: 1.085 };
  const c1 = ledger.addClaim({ text: "EUR/USD closed at 1.0850", kind: "fact", producedBy: "t", runId: "r", links: [link] });
  const c2 = ledger.addClaim({ text: "EUR/USD closed at 1.0850", kind: "fact", producedBy: "t", runId: "r", links: [link] });
  assert.equal(c1.id, c2.id);
  assert.equal((ledger.db.prepare("SELECT COUNT(*) AS n FROM claims").get() as { n: number }).n, 1);
});

test("the ledger is append-only: updates and deletes are rejected by the database", () => {
  const ledger = new EvidenceLedger();
  const s = ledger.addSource(datum());
  const c = ledger.addClaim({ text: "t", kind: "fact", producedBy: "t", runId: "r", links: [{ sourceId: s.id, kind: "field", fieldOrQuote: "value" }] });
  assert.throws(() => ledger.db.exec(`UPDATE sources SET payload = '{}' WHERE id = '${s.id}'`), /append-only/);
  assert.throws(() => ledger.db.exec(`DELETE FROM sources WHERE id = '${s.id}'`), /append-only/);
  assert.throws(() => ledger.db.exec(`UPDATE claims SET text = 'x' WHERE id = '${c.id}'`), /append-only/);
  assert.throws(() => ledger.db.exec(`DELETE FROM links WHERE claim_id = '${c.id}'`), /append-only/);
});

test("verify() exposes tampering that bypasses the triggers", () => {
  const ledger = new EvidenceLedger();
  const s = ledger.addSource(datum());
  assert.deepEqual(ledger.verify(), []);
  ledger.db.exec("DROP TRIGGER sources_no_update");
  ledger.db.exec(`UPDATE sources SET payload = '{"series":"EURUSD","value":9.9}' WHERE id = '${s.id}'`);
  assert.deepEqual(ledger.verify(), [s.id]);
});

test("explain() returns the chain from claim to source with as-of and retrieval times", () => {
  const ledger = new EvidenceLedger();
  const s = ledger.addSource(datum());
  const c = ledger.addClaim({ text: "t", kind: "fact", producedBy: "t", runId: "r", links: [{ sourceId: s.id, kind: "field", fieldOrQuote: "value", value: 1.085 }] });
  const chain = ledger.explain(c.id);
  assert.equal(chain?.sources[0]?.source?.asOf, "2026-09-29");
  assert.equal(chain?.sources[0]?.source?.retrievedAt, "2026-09-30T06:00:00Z");
  assert.equal(getPath(chain?.sources[0]?.source?.payload, "value"), 1.085);
});

test("licence classes gate display: sim_only and restricted never reach paying or public views", () => {
  assert.equal(canDisplay("public", "hosted_paid"), true);
  assert.equal(canDisplay("sim_only", "hosted_paid"), false);
  assert.equal(canDisplay("sim_only", "public"), false);
  assert.equal(canDisplay("user_licensed", "hosted_paid"), false);
  assert.equal(canDisplay("user_licensed", "local_user"), true);
  assert.equal(canDisplay("restricted", "local_user"), false);
});
