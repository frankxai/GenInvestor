import assert from "node:assert/strict";
import { test } from "node:test";
import { claimsAudit, numbersIn } from "../src/audit.ts";
import { EvidenceLedger } from "../src/ledger.ts";

const datum = {
  provider: "fixture",
  url: "fixture://review",
  asOf: "2026-09-30",
  retrievedAt: "2026-10-01T00:00:00Z",
  licenceClass: "restricted" as const,
  delayedBySeconds: 0,
  payload: { value: 1, other: 2 },
};
test("reingestion cannot upgrade evidence rights or rewrite provenance", () => {
  const l = new EvidenceLedger();
  const a = l.addSource(datum);
  const b = l.addSource({ ...datum, licenceClass: "public" });
  assert.notEqual(a.id, b.id);
  assert.deepEqual(
    l.addSource({ ...datum, retrievedAt: "2026-10-02T00:00:00Z" }),
    l.getSource(a.id),
  );
  l.close();
});
test("different evidence creates a different claim instead of appending to an existing claim", () => {
  const l = new EvidenceLedger();
  const s = l.addSource(datum);
  const input = {
    text: "Value 1",
    kind: "fact" as const,
    producedBy: "fixture",
    runId: "r",
    links: [
      {
        sourceId: s.id,
        kind: "field" as const,
        fieldOrQuote: "value",
        value: 1,
      },
    ],
  };
  const a = l.addClaim(input);
  const b = l.addClaim({
    ...input,
    links: [
      ...input.links,
      { ...input.links[0]!, fieldOrQuote: "other", value: 2 },
    ],
  });
  assert.notEqual(a.id, b.id);
  assert.equal(l.getClaim(a.id)?.links.length, 1);
  l.close();
});
test("a partially evidenced claim cannot launder an invented figure", () => {
  const l = new EvidenceLedger();
  const s = l.addSource({ ...datum, licenceClass: "public" });
  const c = l.addClaim({
    text: "Value 1 and 999",
    kind: "fact",
    producedBy: "fixture",
    runId: "r",
    links: [{ sourceId: s.id, kind: "field", fieldOrQuote: "value", value: 1 }],
  });
  assert.equal(
    claimsAudit(
      {
        title: "",
        generatedAt: "",
        lines: [{ text: c.text, claimIds: [c.id] }],
      },
      l,
      { context: "public" },
    ).passed,
    false,
  );
  l.close();
});
test("scientific notation, leading decimals and magnitude suffixes retain numeric meaning", () => {
  assert.deepEqual(
    numbersIn("1e9, .5, -2.5e-3, 4k, 7 million"),
    [1e9, 0.5, -0.0025, 4000, 7000000],
  );
});
test("a failed recomputation blocks the audit without crashing the run", () => {
  const l = new EvidenceLedger();
  const s = l.addSource({ ...datum, licenceClass: "public" });
  const c = l.addClaim({
    text: "Value 1",
    kind: "fact",
    producedBy: "fixture",
    runId: "r",
    links: [
      { sourceId: s.id, kind: "computed", fieldOrQuote: "missing", value: 1 },
    ],
  });
  assert.equal(
    claimsAudit(
      {
        title: "",
        generatedAt: "",
        lines: [{ text: c.text, claimIds: [c.id] }],
      },
      l,
      {
        context: "public",
        recompute: {
          missing: () => {
            throw Error("missing");
          },
        },
      },
    ).passed,
    false,
  );
  l.close();
});

test("a field citation cannot borrow an inherited prototype value", () => {
  const l = new EvidenceLedger();
  const s = l.addSource({ ...datum, licenceClass: "public" });
  const c = l.addClaim({
    text: "Revenue 1",
    kind: "fact",
    producedBy: "fixture",
    runId: "prototype",
    links: [
      {
        sourceId: s.id,
        kind: "field",
        fieldOrQuote: "__proto__.constructor.length",
        value: 1,
      },
    ],
  });
  assert.equal(
    claimsAudit(
      {
        title: "",
        generatedAt: "",
        lines: [{ text: c.text, claimIds: [c.id] }],
      },
      l,
      { context: "public" },
    ).passed,
    false,
  );
  l.close();
});

test("Unicode numerals cannot disappear from an unlinked financial figure", () => {
  assert.deepEqual(numbersIn("Revenue １２"), [12]);
  const l = new EvidenceLedger();
  for (const text of ["Revenue １２", "Revenue ١٢", "Revenue Ⅻ"])
    assert.equal(
      claimsAudit(
        { title: "", generatedAt: "", lines: [{ text, claimIds: [] }] },
        l,
        { context: "public" },
      ).passed,
      false,
    );
  l.close();
});
