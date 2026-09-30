import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPolicyTable } from "../src/contracts.ts";
import { gateNode, runWorkflow, WorkflowStore } from "../src/graph.ts";
import type { NodeDef, Workflow } from "../src/graph.ts";

const table = loadPolicyTable();

function counting(id: string, deps: string[], counter: Record<string, number>, value: unknown): NodeDef {
  return {
    id,
    kind: "compute",
    deps,
    run: () => {
      counter[id] = (counter[id] ?? 0) + 1;
      return { output: value };
    },
  };
}

test("nodes run in dependency order and pass their outputs downstream", async () => {
  const seen: unknown[] = [];
  const wf: Workflow = {
    id: "w",
    version: "1",
    nodes: [
      { id: "c", kind: "publish", deps: ["b"], run: (_c, i) => { seen.push(i.b); return { output: "done" }; } },
      { id: "a", kind: "fetch", deps: [], run: () => ({ output: 2 }) },
      { id: "b", kind: "compute", deps: ["a"], run: (_c, i) => ({ output: (i.a as number) * 21 }) },
    ],
  };
  const report = await runWorkflow(wf, { store: new WorkflowStore(), runId: "r", ctx: {} });
  assert.equal(report.status, "completed");
  assert.deepEqual(seen, [42]);
});

test("a rerun of the same run id reuses checkpoints and re-executes nothing", async () => {
  const counter: Record<string, number> = {};
  const wf: Workflow = { id: "w", version: "1", nodes: [counting("a", [], counter, 1), counting("b", ["a"], counter, 2)] };
  const store = new WorkflowStore();
  await runWorkflow(wf, { store, runId: "r", ctx: {} });
  const second = await runWorkflow(wf, { store, runId: "r", ctx: {} });
  assert.deepEqual(counter, { a: 1, b: 1 });
  assert.equal(second.nodes.a?.reused, true);
});

test("a new workflow version does not reuse old checkpoints", async () => {
  const counter: Record<string, number> = {};
  const store = new WorkflowStore();
  await runWorkflow({ id: "w", version: "1", nodes: [counting("a", [], counter, 1)] }, { store, runId: "r", ctx: {} });
  await runWorkflow({ id: "w", version: "2", nodes: [counting("a", [], counter, 1)] }, { store, runId: "r", ctx: {} });
  assert.equal(counter.a, 2);
});

test("a human node stops the run, downstream waits, and approval resumes without redoing earlier work", async () => {
  const counter: Record<string, number> = {};
  const wf: Workflow = {
    id: "w",
    version: "1",
    nodes: [
      counting("a", [], counter, 1),
      { id: "h", kind: "human", deps: ["a"], run: () => ({ waiting: { approver: "alice", reason: "thesis marked broken" } }) },
      counting("z", ["h"], counter, 3),
    ],
  };
  const store = new WorkflowStore();
  const first = await runWorkflow(wf, { store, runId: "r", ctx: {} });
  assert.equal(first.status, "waiting_human");
  assert.equal(first.nodes.z?.status, "skipped");
  assert.equal(counter.z, undefined);

  store.approve("r", "h", "alice", "approved");
  const second = await runWorkflow(wf, { store, runId: "r", ctx: {} });
  assert.equal(second.status, "completed");
  assert.equal(counter.a, 1, "already-completed work is not redone");
  assert.equal(counter.z, 1);
});

test("a rejected approval blocks the run", async () => {
  const wf: Workflow = {
    id: "w",
    version: "1",
    nodes: [{ id: "h", kind: "human", deps: [], run: () => ({ waiting: { approver: "alice", reason: "check" } }) }],
  };
  const store = new WorkflowStore();
  store.approve("r", "h", "alice", "rejected");
  const report = await runWorkflow(wf, { store, runId: "r", ctx: {} });
  assert.equal(report.status, "blocked");
});

test("a blocked node skips its dependants but independent branches still run", async () => {
  const counter: Record<string, number> = {};
  const wf: Workflow = {
    id: "w",
    version: "1",
    nodes: [
      { id: "bad", kind: "audit", deps: [], run: () => ({ block: "unlinked number" }) },
      counting("after", ["bad"], counter, 1),
      counting("independent", [], counter, 1),
    ],
  };
  const report = await runWorkflow(wf, { store: new WorkflowStore(), runId: "r", ctx: {} });
  assert.equal(report.status, "blocked");
  assert.equal(report.nodes.after?.status, "skipped");
  assert.equal(counter.independent, 1);
  assert.equal(counter.after, undefined);
});

test("a throwing node is reported as failed and is not checkpointed", async () => {
  let attempts = 0;
  const wf: Workflow = {
    id: "w",
    version: "1",
    nodes: [{ id: "flaky", kind: "fetch", deps: [], run: () => { attempts += 1; if (attempts === 1) throw new Error("network"); return { output: "ok" }; } }],
  };
  const store = new WorkflowStore();
  const first = await runWorkflow(wf, { store, runId: "r", ctx: {} });
  assert.equal(first.status, "failed");
  const second = await runWorkflow(wf, { store, runId: "r", ctx: {} });
  assert.equal(second.status, "completed");
  assert.equal(attempts, 2);
});

test("cycles and unknown dependencies are rejected", async () => {
  const cyc: Workflow = {
    id: "w", version: "1",
    nodes: [
      { id: "a", kind: "compute", deps: ["b"], run: () => ({ output: 1 }) },
      { id: "b", kind: "compute", deps: ["a"], run: () => ({ output: 1 }) },
    ],
  };
  await assert.rejects(runWorkflow(cyc, { store: new WorkflowStore(), runId: "r", ctx: {} }), /cycle/);
  const unknown: Workflow = { id: "w", version: "1", nodes: [{ id: "a", kind: "compute", deps: ["ghost"], run: () => ({ output: 1 }) }] };
  await assert.rejects(runWorkflow(unknown, { store: new WorkflowStore(), runId: "r", ctx: {} }), /unknown node/);
});

test("gate nodes follow the policy table: allow passes, human_gate waits, blocked stops", async () => {
  const store = new WorkflowStore();
  const mk = (verb: string): Workflow => ({ id: "g", version: "1", nodes: [gateNode("gate", [], table, { action_type: verb })] });
  assert.equal((await runWorkflow(mk("artifact_write"), { store, runId: "a", ctx: {} })).status, "completed");
  assert.equal((await runWorkflow(mk("live_trade"), { store, runId: "b", ctx: {} })).status, "waiting_human");
  assert.equal((await runWorkflow(mk("store_secret"), { store, runId: "c", ctx: {} })).status, "blocked");
});
