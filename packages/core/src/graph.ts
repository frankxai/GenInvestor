import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256 } from "./ledger.ts";
import { evaluate } from "./policy.ts";
import type { ActionInput, PolicyTable } from "./policy.ts";

export type NodeKind = "fetch" | "compute" | "analyse" | "verify" | "audit" | "gate" | "human" | "publish";
export type NodeStatus = "completed" | "waiting_human" | "blocked" | "failed" | "skipped";
export type RunStatus = "completed" | "waiting_human" | "blocked" | "failed";

export type NodeResult =
  | { output: unknown }
  | { waiting: { approver: string; reason: string } }
  | { block: string };

export interface NodeDef<C = unknown> {
  id: string;
  kind: NodeKind;
  deps: string[];
  run: (ctx: C, inputs: Record<string, unknown>) => Promise<NodeResult> | NodeResult;
}

export interface Workflow<C = unknown> {
  id: string;
  version: string;
  nodes: NodeDef<C>[];
}

export interface NodeReport {
  status: NodeStatus;
  output?: unknown;
  reason?: string;
  reused?: boolean;
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  nodes: Record<string, NodeReport>;
}

/** Checkpoints and approvals. Durable, so a run can stop at a human node and resume later. */
export class WorkflowStore {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        run_id TEXT NOT NULL, node_id TEXT NOT NULL, idem_key TEXT NOT NULL,
        output TEXT NOT NULL, completed_at TEXT NOT NULL, PRIMARY KEY (run_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        run_id TEXT NOT NULL, node_id TEXT NOT NULL, approver TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')), note TEXT, at TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  checkpoint(runId: string, nodeId: string): { idemKey: string; output: unknown } | undefined {
    const r = this.db.prepare("SELECT idem_key, output FROM checkpoints WHERE run_id = ? AND node_id = ?").get(runId, nodeId) as
      | { idem_key: string; output: string }
      | undefined;
    return r ? { idemKey: r.idem_key, output: JSON.parse(r.output) } : undefined;
  }

  saveCheckpoint(runId: string, nodeId: string, idemKey: string, output: unknown): void {
    this.db
      .prepare("INSERT OR REPLACE INTO checkpoints (run_id, node_id, idem_key, output, completed_at) VALUES (?,?,?,?,?)")
      .run(runId, nodeId, idemKey, canonicalJson(output ?? null), new Date().toISOString());
  }

  approve(runId: string, nodeId: string, approver: string, decision: "approved" | "rejected", note?: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO approvals (run_id, node_id, approver, decision, note, at) VALUES (?,?,?,?,?,?)")
      .run(runId, nodeId, approver, decision, note ?? null, new Date().toISOString());
  }

  approval(runId: string, nodeId: string): { approver: string; decision: "approved" | "rejected" } | undefined {
    return this.db.prepare("SELECT approver, decision FROM approvals WHERE run_id = ? AND node_id = ?").get(runId, nodeId) as
      | { approver: string; decision: "approved" | "rejected" }
      | undefined;
  }
}

function topologicalOrder<C>(wf: Workflow<C>): NodeDef<C>[] {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  if (byId.size !== wf.nodes.length) throw new Error(`Workflow ${wf.id} has duplicate node ids`);
  const indegree = new Map<string, number>();
  for (const n of wf.nodes) {
    for (const d of n.deps) if (!byId.has(d)) throw new Error(`Node ${n.id} depends on unknown node ${d}`);
    indegree.set(n.id, n.deps.length);
  }
  const ready = wf.nodes.filter((n) => n.deps.length === 0).map((n) => n.id);
  const order: NodeDef<C>[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(byId.get(id) as NodeDef<C>);
    for (const n of wf.nodes) {
      if (n.deps.includes(id)) {
        const left = (indegree.get(n.id) as number) - 1;
        indegree.set(n.id, left);
        if (left === 0) ready.push(n.id);
      }
    }
  }
  if (order.length !== wf.nodes.length) throw new Error(`Workflow ${wf.id} has a cycle`);
  return order;
}

export async function runWorkflow<C>(wf: Workflow<C>, opts: { store: WorkflowStore; runId: string; ctx: C }): Promise<RunReport> {
  const report: RunReport = { runId: opts.runId, status: "completed", nodes: {} };
  const outputs: Record<string, unknown> = {};

  for (const node of topologicalOrder(wf)) {
    const blockedBy = node.deps.find((d) => report.nodes[d]?.status !== "completed");
    if (blockedBy) {
      report.nodes[node.id] = { status: "skipped", reason: `upstream ${blockedBy} is ${report.nodes[blockedBy]?.status}` };
      continue;
    }

    const inputs = Object.fromEntries(node.deps.map((d) => [d, outputs[d]]));
    const idemKey = sha256(`${wf.id}|${wf.version}|${node.id}|${canonicalJson(inputs)}`);

    const cached = opts.store.checkpoint(opts.runId, node.id);
    if (cached && cached.idemKey === idemKey) {
      outputs[node.id] = cached.output;
      report.nodes[node.id] = { status: "completed", output: cached.output, reused: true };
      continue;
    }

    let result: NodeResult;
    try {
      result = await node.run(opts.ctx, inputs);
    } catch (error) {
      report.nodes[node.id] = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
      report.status = "failed";
      continue;
    }

    if ("block" in result) {
      report.nodes[node.id] = { status: "blocked", reason: result.block };
      if (report.status === "completed") report.status = "blocked";
    } else if ("waiting" in result) {
      const approval = opts.store.approval(opts.runId, node.id);
      if (approval?.decision === "approved") {
        const output = { approved: true, approver: approval.approver };
        opts.store.saveCheckpoint(opts.runId, node.id, idemKey, output);
        outputs[node.id] = output;
        report.nodes[node.id] = { status: "completed", output };
      } else if (approval?.decision === "rejected") {
        report.nodes[node.id] = { status: "blocked", reason: `rejected by ${approval.approver}: ${result.waiting.reason}` };
        if (report.status === "completed") report.status = "blocked";
      } else {
        report.nodes[node.id] = { status: "waiting_human", reason: `${result.waiting.approver}: ${result.waiting.reason}` };
        if (report.status === "completed") report.status = "waiting_human";
      }
    } else {
      opts.store.saveCheckpoint(opts.runId, node.id, idemKey, result.output);
      outputs[node.id] = result.output;
      report.nodes[node.id] = { status: "completed", output: result.output };
    }
  }
  return report;
}

/** A gate node: allow passes, human_gate waits for an approver, blocked stops the run. */
export function gateNode<C>(id: string, deps: string[], table: PolicyTable | ((ctx: C) => PolicyTable), action: ActionInput): NodeDef<C> {
  return {
    id,
    kind: "gate",
    deps,
    run: (ctx) => {
      const d = evaluate(typeof table === "function" ? table(ctx) : table, action);
      if (d.verdict === "allow") return { output: { verdict: d.verdict, action: action.action_type } };
      if (d.verdict === "human_gate") return { waiting: { approver: "human", reason: d.reason } };
      return { block: d.reason };
    },
  };
}
