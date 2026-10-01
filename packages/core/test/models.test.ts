import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ModelAdapter,
  maskedComparison,
  researchModelPass,
  validateModelResponse,
} from "../src/models.ts";
import { EvidenceLedger } from "../src/ledger.ts";
function fixture() {
  const ledger = new EvidenceLedger();
  const s = ledger.addSource({
    provider: "fixture",
    url: "fixture://model",
    asOf: "2026-09-30",
    retrievedAt: "2026-10-01T00:00:00Z",
    licenceClass: "public",
    delayedBySeconds: 0,
    payload: { note: "DEMOCO evidence is incomplete" },
  });
  const c = ledger.addClaim({
    text: "DEMOCO evidence is incomplete",
    kind: "fact",
    producedBy: "fixture",
    runId: "model",
    links: [
      {
        sourceId: s.id,
        kind: "quote",
        fieldOrQuote: "DEMOCO evidence is incomplete",
      },
    ],
  });
  return {
    ledger,
    lines: [{ text: c.text, claimIds: [c.id] }],
    entities: [{ ticker: "DEMO", name: "DEMOCO" }],
    asOf: "2026-09-30",
    seed: "fixture-seed",
    auditOptions: { context: "public" as const },
  };
}
test("numeric, advice, forecast and unsupported model notes are rejected", () => {
  const ids = new Set(["evidence"]);
  for (const text of [
    "Revenue is 999.",
    "Revenue is one million.",
    "Buy this company.",
    "A likely outcome.",
    "Price target is attractive.",
    "Purchase shares.",
    "Revenue is twenty million.",
    "Revenue is １２.",
  ])
    assert.throws(() =>
      validateModelResponse(
        { notes: [{ text, claimIds: ["evidence"] }] },
        ids,
        "analyst",
      ),
    );
  assert.throws(() =>
    validateModelResponse(
      { notes: [{ text: "Evidence is incomplete.", claimIds: ["invented"] }] },
      ids,
      "analyst",
    ),
  );
});
test("three native provider contracts and a masked comparison run without live requests", async () => {
  const opts = fixture();
  const seen: any[] = [];
  const create = (provider: "openai" | "anthropic" | "google") =>
    new ModelAdapter(
      { provider, model: "explicit-model" },
      {
        key: () => "fixture-credential",
        fetchImpl: async (url, init) => {
          const request = JSON.parse(String(init.body));
          seen.push({ provider, url, request });
          const text = JSON.stringify({
            notes: [
              {
                text: "Evidence remains incomplete.",
                claimIds: opts.lines[0]!.claimIds,
              },
            ],
            accepted: true,
          });
          return {
            ok: true,
            status: 200,
            json: async () =>
              provider === "openai"
                ? { output: [{ content: [{ type: "output_text", text }] }] }
                : provider === "anthropic"
                  ? { content: [{ type: "text", text }] }
                  : { candidates: [{ content: { parts: [{ text }] } }] },
          };
        },
      },
    );
  const team = {
    analyst: create("openai"),
    skeptic: create("anthropic"),
    verifier: create("google"),
  };
  const result = await maskedComparison({ ...opts, team });
  assert.equal(seen.length, 6);
  assert.ok(!JSON.stringify(seen.slice(0, 3)).includes("DEMOCO"));
  assert.ok(JSON.stringify(seen.slice(3)).includes("DEMOCO"));
  assert.equal(result.masked.verifier.accepted, true);
  opts.ledger.close();
});
test("a repeated provider or planted error blocks before network access", async () => {
  const opts = fixture();
  let calls = 0;
  const a = new ModelAdapter(
    { provider: "openai", model: "explicit-model" },
    {
      key: () => "fixture",
      fetchImpl: async () => {
        calls++;
        throw Error("must not run");
      },
    },
  );
  await assert.rejects(
    researchModelPass({
      ...opts,
      team: { analyst: a, skeptic: a, verifier: a },
    }),
    /different providers/,
  );
  const b = new ModelAdapter({
    provider: "anthropic",
    model: "explicit-model",
  });
  const c = new ModelAdapter({ provider: "google", model: "explicit-model" });
  await assert.rejects(
    researchModelPass({
      ...opts,
      lines: [{ ...opts.lines[0]!, text: "Revenue was 999" }],
      team: { analyst: a, skeptic: b, verifier: c },
    }),
    /failed audit/,
  );
  assert.equal(calls, 0);
  opts.ledger.close();
});
