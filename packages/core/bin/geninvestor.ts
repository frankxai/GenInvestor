#!/usr/bin/env node
// Local-first CLI. The ledger and checkpoints live in ./.geninvestor by default; nothing leaves the machine
// except the requests the chosen provider makes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EcbProvider, ECB_SERIES, EvidenceLedger, evaluate, loadPolicyTable, RulesVerifier, runWorkflow, TemplateAnalyst, todayWorkflow, WorkflowStore } from "../src/index.ts";
import type { Thesis } from "../src/index.ts";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name: string) => args.includes(`--${name}`);

const home = flag("home", join(process.cwd(), ".geninvestor")) as string;
mkdirSync(home, { recursive: true });

function usage(): never {
  console.log(`geninvestor <command>

  today [--out DIR] [--thesis FILE.json] [--approve NODE] [--run ID]   Build today's sourced brief from ECB data
  explain <claimId>                                                    Show the evidence chain behind a claim
  verify                                                               Re-hash every stored source and report tampering
  policy <verb>                                                        Ask the autonomy gate about an action

  --home DIR   where the ledger lives (default ./.geninvestor)
Information, not advice. Ceiling: simulation only.`);
  process.exit(command ? 2 : 0);
}

async function main() {
  const table = loadPolicyTable();
  if (command === "policy") {
    const verb = args[1];
    if (!verb) usage();
    const d = evaluate(table, { action_type: verb });
    console.log(`${verb}: ${d.verdict}. ${d.reason}`);
    process.exit(d.verdict === "allow" ? 0 : 2);
  }

  const ledger = new EvidenceLedger(join(home, "ledger.db"));

  if (command === "verify") {
    const bad = ledger.verify();
    console.log(bad.length === 0 ? "ledger ok: every stored source matches its hash" : `TAMPERED sources: ${bad.join(", ")}`);
    process.exit(bad.length === 0 ? 0 : 1);
  }

  if (command === "explain") {
    const id = args[1];
    if (!id) usage();
    const chain = ledger.explain(id);
    if (!chain) {
      console.log(`no claim ${id}`);
      process.exit(1);
    }
    console.log(`${chain.claim.kind.toUpperCase()}: ${chain.claim.text}`);
    for (const { link, source } of chain.sources) {
      console.log(`  ${link.kind} ${link.fieldOrQuote}${link.value ? ` = ${link.value}` : ""}`);
      console.log(`    source ${source?.provider} ${source?.url}`);
      console.log(`    as of ${source?.asOf}, retrieved ${source?.retrievedAt}, sha256 ${source?.sha256.slice(0, 16)}…, licence ${source?.licenceClass}`);
    }
    process.exit(0);
  }

  if (command === "today") {
    const thesisFile = flag("thesis");
    const theses: Thesis[] = thesisFile ? JSON.parse((await import("node:fs")).readFileSync(thesisFile, "utf8")) : [];
    const store = new WorkflowStore(join(home, "runs.db"));
    const runId = flag("run", `today-${new Date().toISOString().slice(0, 10)}`) as string;
    const approve = flag("approve");
    if (approve) store.approve(runId, approve, process.env.USER ?? process.env.USERNAME ?? "owner", "approved");

    const report = await runWorkflow(todayWorkflow(), {
      store,
      runId,
      ctx: {
        ledger,
        table,
        provider: new EcbProvider(),
        analyst: new TemplateAnalyst(),
        verifier: new RulesVerifier(),
        watchlist: Object.keys(ECB_SERIES),
        theses,
        displayContext: "local_user",
        outDir: flag("out", join(home, "briefs")),
      },
    });
    for (const [id, n] of Object.entries(report.nodes)) console.log(`${n.status.padEnd(14)} ${id}${n.reason ? `  ${n.reason}` : ""}${n.reused ? "  (reused)" : ""}`);
    console.log(`run ${runId}: ${report.status}`);
    if (report.status === "waiting_human") console.log(`approve with: geninvestor today --run ${runId} --approve human`);
    const out = report.nodes.publish?.output as { markdown: string } | undefined;
    if (out) console.log(`\n${out.markdown}`);
    process.exit(report.status === "completed" ? 0 : 3);
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
