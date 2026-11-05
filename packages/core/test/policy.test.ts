import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPolicyTable } from "../src/contracts.ts";
import { evaluate, PolicyViolation, require as requireAction } from "../src/policy.ts";

const table = loadPolicyTable();

test("every shared guardrail case gets the verdict the contract expects", () => {
  assert.ok(table.cases.length >= 30);
  for (const c of table.cases) {
    assert.equal(evaluate(table, c.action).verdict, c.expect, `${c.id}: ${c.why}`);
  }
});

test("the case list covers all three verdicts", () => {
  assert.deepEqual([...new Set(table.cases.map((c) => c.expect))].sort(), ["allow", "blocked", "human_gate"]);
});

test("a sabotaged gate is caught by the shared cases, in both directions", () => {
  const failing = (t: typeof table) => table.cases.filter((c) => evaluate(t, c.action).verdict !== c.expect);
  assert.equal(failing(table).length, 0);
  // drop every human-gate and hard-block verb: dangerous actions now slide through to "outside the mode"
  const lax = { ...table, humanGate: [], hardBlocked: [] };
  assert.ok(failing(lax).length > 0, "removing the danger lists must fail some cases");
  // allow everything at the ceiling: research verbs move but so does everything else
  const allowAll = { ...table, allowedByMode: { ...table.allowedByMode, [table.ceiling]: [...(table.allowedByMode[table.ceiling] ?? []), "live_trade", "transfer"] }, humanGate: [] };
  assert.ok(failing(allowAll).length > 0, "allowing live_trade at the ceiling must fail some cases");
  // refuse everything: safe work is blocked
  const strict = { ...table, allowedByMode: { ...table.allowedByMode, [table.ceiling]: [] } };
  assert.ok(failing(strict).length > 0, "an empty allow list must fail the safe-work cases");
});

test("require refuses modes above the ceiling and non-allow verdicts", () => {
  assert.throws(() => requireAction(table, "research", { mode: "L3_HUMAN_APPROVED_DRAFT" }), PolicyViolation);
  assert.throws(() => requireAction(table, "live_trade"), /human_gate/);
  assert.throws(() => requireAction(table, "store_secret"), /blocked/);
  assert.equal(requireAction(table, "backtest").verdict, "allow");
  assert.equal(requireAction(table, "research", { mode: "L0_RESEARCH" }).verdict, "allow");
});

test("verb matching is exact: case variants and empty verbs fail closed", () => {
  assert.equal(evaluate(table, { action_type: "Backtest" }).verdict, "human_gate");
  assert.equal(evaluate(table, { action_type: "" }).verdict, "human_gate");
});
