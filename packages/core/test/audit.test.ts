import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsAudit, numbersIn } from "../src/audit.ts";
import type { Brief } from "../src/audit.ts";
import { EvidenceLedger } from "../src/ledger.ts";

function setup() {
  const ledger = new EvidenceLedger();
  const source = ledger.addSource({
    provider: "fixture",
    url: "fixture://eurusd",
    asOf: "2026-09-29",
    retrievedAt: "2026-09-30T06:00:00Z",
    licenceClass: "public",
    delayedBySeconds: 0,
    payload: { series: "EURUSD", value: 1.085, prior: 1.0817, note: "Euro foreign exchange reference rate" },
  });
  const claim = ledger.addClaim({
    text: "EUR/USD was 1.085 on 2026-09-29, up 0.3% on the prior observation",
    kind: "fact",
    producedBy: "test",
    runId: "run-1",
    links: [
      { sourceId: source.id, kind: "field", fieldOrQuote: "value", value: 1.085 },
      { sourceId: source.id, kind: "computed", fieldOrQuote: "pct_change", value: 0.3 },
    ],
  });
  const recompute = { pct_change: (p: unknown) => Math.round((((p as { value: number; prior: number }).value / (p as { prior: number }).prior - 1) * 100) * 10) / 10 };
  return { ledger, source, claim, recompute };
}

const brief = (lines: Brief["lines"]): Brief => ({ title: "t", generatedAt: "2026-09-30T06:00:00Z", lines });

test("a fully linked, correct line passes", () => {
  const { ledger, claim, recompute } = setup();
  const result = claimsAudit(brief([{ text: "EUR/USD was 1.085, up 0.3%.", claimIds: [claim.id] }]), ledger, { context: "local_user", recompute });
  assert.deepEqual(result.findings, []);
  assert.equal(result.passed, true);
});

test("a fabricated number with no claim is blocked", () => {
  const { ledger, recompute } = setup();
  const result = claimsAudit(brief([{ text: "Inflation hit 9.9% overnight.", claimIds: [] }]), ledger, { context: "local_user", recompute });
  assert.equal(result.passed, false);
  assert.equal(result.findings[0]?.code, "UNLINKED_NUMBER");
});

test("a number that is not in the linked claims is blocked even if the line cites a real claim", () => {
  const { ledger, claim, recompute } = setup();
  const result = claimsAudit(brief([{ text: "EUR/USD was 1.099, up 0.3%.", claimIds: [claim.id] }]), ledger, { context: "local_user", recompute });
  assert.ok(result.findings.some((f) => f.code === "NUMBER_NOT_IN_CLAIMS" && f.detail.includes("1.099")));
});

test("a claim whose stated value disagrees with its source field is blocked", () => {
  const { ledger, source, recompute } = setup();
  const lying = ledger.addClaim({
    text: "EUR/USD was 1.2",
    kind: "fact",
    producedBy: "test",
    runId: "run-2",
    links: [{ sourceId: source.id, kind: "field", fieldOrQuote: "value", value: 1.2 }],
  });
  const result = claimsAudit(brief([{ text: "EUR/USD was 1.2", claimIds: [lying.id] }]), ledger, { context: "local_user", recompute });
  assert.ok(result.findings.some((f) => f.code === "FIELD_MISMATCH"));
});

test("a computed value that does not recompute is blocked, and so is a missing recompute function", () => {
  const { ledger, source } = setup();
  const wrong = ledger.addClaim({
    text: "Up 5%",
    kind: "fact",
    producedBy: "test",
    runId: "run-3",
    links: [{ sourceId: source.id, kind: "computed", fieldOrQuote: "pct_change", value: 5 }],
  });
  const recompute = { pct_change: (p: unknown) => (((p as { value: number; prior: number }).value / (p as { prior: number }).prior - 1) * 100) };
  const bad = claimsAudit(brief([{ text: "Up 5%", claimIds: [wrong.id] }]), ledger, { context: "local_user", recompute });
  assert.ok(bad.findings.some((f) => f.code === "RECOMPUTE_MISMATCH"));
  const none = claimsAudit(brief([{ text: "Up 5%", claimIds: [wrong.id] }]), ledger, { context: "local_user" });
  assert.ok(none.findings.some((f) => f.code === "RECOMPUTE_MISMATCH"));
});

test("quotes must match the source byte for byte", () => {
  const { ledger, source } = setup();
  const ok = ledger.addClaim({ text: "It is the Euro foreign exchange reference rate", kind: "fact", producedBy: "t", runId: "q1", links: [{ sourceId: source.id, kind: "quote", fieldOrQuote: "Euro foreign exchange reference rate" }] });
  const bad = ledger.addClaim({ text: "It is the euro foreign exchange reference rate", kind: "fact", producedBy: "t", runId: "q2", links: [{ sourceId: source.id, kind: "quote", fieldOrQuote: "euro foreign exchange reference rate" }] });
  assert.equal(claimsAudit(brief([{ text: ok.text, claimIds: [ok.id] }]), ledger, { context: "local_user" }).passed, true);
  assert.ok(claimsAudit(brief([{ text: bad.text, claimIds: [bad.id] }]), ledger, { context: "local_user" }).findings.some((f) => f.code === "QUOTE_MISMATCH"));
});

test("an unknown claim id is blocked", () => {
  const { ledger } = setup();
  const result = claimsAudit(brief([{ text: "no numbers here", claimIds: ["deadbeef"] }]), ledger, { context: "local_user" });
  assert.equal(result.findings[0]?.code, "UNKNOWN_CLAIM");
});

test("tampered sources and licence-blocked sources are blocked", () => {
  const { ledger, source, claim, recompute } = setup();
  ledger.db.exec("DROP TRIGGER sources_no_update");
  ledger.db.exec(`UPDATE sources SET payload = '{"value":1.085,"prior":1.0817,"series":"X"}' WHERE id = '${source.id}'`);
  const tampered = claimsAudit(brief([{ text: "EUR/USD was 1.085, up 0.3%.", claimIds: [claim.id] }]), ledger, { context: "local_user", recompute });
  assert.ok(tampered.findings.some((f) => f.code === "SOURCE_TAMPERED"));

  const sim = new EvidenceLedger();
  const s = sim.addSource({ provider: "sim", url: "sim://x", asOf: "2026-09-29", retrievedAt: "2026-09-30T00:00:00Z", licenceClass: "sim_only", delayedBySeconds: 0, payload: { v: 2 } });
  const c = sim.addClaim({ text: "v is 2", kind: "fact", producedBy: "t", runId: "s", links: [{ sourceId: s.id, kind: "field", fieldOrQuote: "v", value: 2 }] });
  const b = brief([{ text: "v is 2", claimIds: [c.id] }]);
  assert.equal(claimsAudit(b, sim, { context: "local_user" }).passed, true);
  assert.ok(claimsAudit(b, sim, { context: "hosted_paid" }).findings.some((f) => f.code === "DISPLAY_BLOCKED"));
});

test("a claim cannot cite a value its own text does not state", () => {
  const { ledger, source } = setup();
  const sneaky = ledger.addClaim({
    text: "EUR/USD was about one and a tenth",
    kind: "fact", producedBy: "test", runId: "sneaky",
    links: [{ sourceId: source.id, kind: "field", fieldOrQuote: "value", value: 1.085 }],
  });
  const r = claimsAudit(brief([{ text: "EUR/USD was about one and a tenth", claimIds: [sneaky.id] }]), ledger, { context: "local_user" });
  assert.ok(r.findings.some((f) => f.code === "LINK_VALUE_NOT_STATED"));
});

test("the value check ignores sign, so 'down 0.2%' may cite -0.2", () => {
  const { ledger, source } = setup();
  const c = ledger.addClaim({
    text: "It was down 0.2% on the prior observation",
    kind: "fact", producedBy: "test", runId: "signs",
    links: [{ sourceId: source.id, kind: "computed", fieldOrQuote: "pct_change", value: -0.2 }],
  });
  const recompute = { pct_change: () => -0.2 };
  assert.equal(claimsAudit(brief([{ text: "It was down 0.2% on the prior observation", claimIds: [c.id] }]), ledger, { context: "local_user", recompute }).passed, true);
});

test("text-valued field links (such as a filing date) are compared as text", () => {
  const ledger = new EvidenceLedger();
  const s = ledger.addSource({ provider: "p", url: "u://x", asOf: "2026-01-01", retrievedAt: "2026-01-02T00:00:00Z", licenceClass: "public", delayedBySeconds: 0, payload: { filed: "2025-03-21" } });
  const ok = ledger.addClaim({ text: "The annual report was filed on 2025-03-21", kind: "fact", producedBy: "t", runId: "d1", links: [{ sourceId: s.id, kind: "field", fieldOrQuote: "filed", value: "2025-03-21" }] });
  const bad = ledger.addClaim({ text: "The annual report was filed on 2025-03-22", kind: "fact", producedBy: "t", runId: "d2", links: [{ sourceId: s.id, kind: "field", fieldOrQuote: "filed", value: "2025-03-22" }] });
  assert.equal(claimsAudit(brief([{ text: "The annual report was filed on 2025-03-21", claimIds: [ok.id] }]), ledger, { context: "local_user" }).passed, true);
  assert.ok(claimsAudit(brief([{ text: "The annual report was filed on 2025-03-22", claimIds: [bad.id] }]), ledger, { context: "local_user" }).findings.some((f) => f.code === "FIELD_MISMATCH"));
});

test("a citation must support the line: a number-free line cannot cite an unrelated claim", () => {
  const { ledger, claim } = setup();
  const unrelated = claimsAudit(brief([{ text: "Management is confident about the outlook.", claimIds: [claim.id] }]), ledger, { context: "local_user" });
  assert.ok(unrelated.findings.some((f) => f.code === "CITATION_NOT_SUPPORTING"));
  // supported two ways: the claim's own words, or a shared figure
  assert.equal(claimsAudit(brief([{ text: claim.text, claimIds: [claim.id] }]), ledger, { context: "local_user", recompute: { pct_change: () => 0.3 } }).passed, true);
  assert.equal(claimsAudit(brief([{ text: "That is a move of 0.3% in one day.", claimIds: [claim.id] }]), ledger, { context: "local_user", recompute: { pct_change: () => 0.3 } }).passed, true);
  assert.equal(claimsAudit(brief([{ text: "Nothing to cite here." , claimIds: [] }]), ledger, { context: "local_user" }).passed, true, "a line with no citation and no figure is just prose");
});

test("figures are compared exactly: one dollar on a billion is a difference", () => {
  const ledger = new EvidenceLedger();
  const s = ledger.addSource({ provider: "p", url: "u://x", asOf: "2026-01-01", retrievedAt: "2026-01-02T00:00:00Z", licenceClass: "public", delayedBySeconds: 0, payload: { revenue: 1_200_000_000 } });
  const exact = ledger.addClaim({ text: "Revenue was 1,200,000,000 USD", kind: "fact", producedBy: "t", runId: "e", links: [{ sourceId: s.id, kind: "field", fieldOrQuote: "revenue", value: 1_200_000_000 }] });
  const off = ledger.addClaim({ text: "Revenue was 1,200,000,001 USD", kind: "fact", producedBy: "t", runId: "o", links: [{ sourceId: s.id, kind: "field", fieldOrQuote: "revenue", value: 1_200_000_001 }] });
  assert.equal(claimsAudit(brief([{ text: exact.text, claimIds: [exact.id] }]), ledger, { context: "local_user" }).passed, true);
  const r = claimsAudit(brief([{ text: off.text, claimIds: [off.id] }]), ledger, { context: "local_user" });
  assert.ok(r.findings.some((f) => f.code === "FIELD_MISMATCH"));
  // floating-point noise from a division is not a difference
  const noisy = ledger.addClaim({ text: "Growth was 29.21%", kind: "fact", producedBy: "t", runId: "n", links: [{ sourceId: s.id, kind: "computed", fieldOrQuote: "g", value: 29.21 }] });
  assert.equal(claimsAudit(brief([{ text: noisy.text, claimIds: [noisy.id] }]), ledger, { context: "local_user", recompute: { g: () => 29.209999999999997 } }).passed, true);
});

test("dates are not treated as numbers that need evidence", () => {
  assert.deepEqual(numbersIn("On 2026-09-29 the rate was 1,085.5"), [1085.5]);
});
