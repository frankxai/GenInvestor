#!/usr/bin/env node
// Local-first CLI. The ledger and checkpoints live in ./.geninvestor by default; nothing leaves the machine
// except the requests the chosen provider makes.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  claimsAudit, CalibrationLedger, EcbProvider, ECB_SERIES, EvidenceLedger, evaluate, EXAMPLE_MANDATE, FilePriceSource, FileSecSource, loadMandate, loadPolicyTable, RulesSkeptic,
  RECOMPUTE, RulesVerifier, runWorkflow, SCOUT_RECOMPUTE, scoutWorkflow, SecProvider, TemplateAnalyst, todayWorkflow, WorkflowStore,
} from "../src/index.ts";
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

  mandate example                                                      Print a starting mandate (your own rules)
  mandate check <file>                                                 Validate a mandate file
  scout --mandate FILE [--prices-dir DIR] [--out DIR] [--run ID] [--as-of DATE]           Find candidates for research against your mandate (SEC filings).
                                                                       --as-of runs it as it would have run then: only filings public by that date
  calls due | list                                                   Read your local resolution record (figures withheld)

  --home DIR   where the ledger lives (default ./.geninvestor)
  scout needs GENINVESTOR_SEC_IDENTITY="Your Name your@email" (the SEC requires a contact on every request),
  or --facts-dir DIR to read recorded company-facts files (<TICKER>.json) offline with no identity
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

  if (command === "mandate") {
    if (args[1] === "example") {
      console.log(JSON.stringify(EXAMPLE_MANDATE, null, 2));
      process.exit(0);
    }
    if (args[1] === "check" && args[2]) {
      const r = loadMandate(args[2]);
      for (const e of r.errors) console.log(`error: ${e}`);
      for (const w of r.warnings) console.log(`note: ${w}`);
      console.log(r.valid ? "mandate ok" : "mandate invalid");
      process.exit(r.valid ? 0 : 1);
    }
    usage();
  }

  if (command === "calls") {
    const cal = new CalibrationLedger(join(home, "calibration.db"));
    const show = (c: ReturnType<CalibrationLedger["list"]>[number]) =>
      `${c.id}  resolves ${c.resolvesOn}  ${c.outcome === null ? "open" : c.outcome === 1 ? "HAPPENED" : "did not happen"}`;
    try {
      if (args[1] === "register") {
        const claim = flag("claim");
        const p = Number(flag("p"));
        const resolves = flag("resolves");
        const source = flag("source");
        if (!claim || !resolves || !source || !Number.isFinite(p)) usage();
        const row = cal.register({ claim, probability: p, resolvesOn: resolves, resolutionSource: source, baseline: flag("baseline") ? Number(flag("baseline")) : null, sourceCard: flag("card") ?? null });
        console.log(`registered ${row.id} at ${row.registeredAt}. It cannot be edited or back-dated.`);
      } else if (args[1] === "resolve" && args[2]) {
        const o = flag("outcome");
        if (o !== "0" && o !== "1") usage();
        console.log(show(cal.resolve(args[2], Number(o) as 0 | 1, flag("note"))));
      } else if (args[1] === "due") {
        const due = cal.due();
        console.log(due.length ? due.map(show).join("\n") : "nothing is due");
      } else if (args[1] === "list") {
        const all = cal.list();
        console.log(all.length ? all.map(show).join("\n") : "no calls registered");
      } else if (args[1] === "score") {
        const { reliability: _privateBands, ...score } = cal.score();
        const evidence = new EvidenceLedger(join(home,"ledger.db"));
        try {
          const counts = { open: score.open, resolved: score.resolved };
          const source = evidence.addSource({provider:"resolution-record",url:"local://calibration/counts",asOf:new Date().toISOString().slice(0,10),retrievedAt:new Date().toISOString(),licenceClass:"user_licensed",delayedBySeconds:0,payload:counts});
          const claims = Object.entries(counts).map(([key,value])=> evidence.addClaim({text:`${key}: ${value}`,kind:"fact",producedBy:"resolution-record",runId:source.id,links:[{sourceId:source.id,kind:"field",fieldOrQuote:key,value}]}));
          const audit = claimsAudit({title:"",generatedAt:"",lines:claims.map(c=>({text:c.text,claimIds:[c.id]}))},evidence,{context:"local_user"});
          if (!audit.passed) throw Error("Resolution counts failed audit");
          console.log(JSON.stringify({...counts,claimIds:claims.map(c=>c.id),note:"Scores and probability bands are withheld; the sample floor does not replace a linked audit."},null,2));
        } finally {evidence.close();}
      } else {
        usage();
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      cal.close();
    }
    process.exit(0);
  }

  const ledger = new EvidenceLedger(join(home, "ledger.db"));

  if (command === "scout") {
    const file = flag("mandate");
    if (!file) usage();
    const m = loadMandate(file);
    if (!m.valid || !m.mandate) {
      for (const e of m.errors) console.error(`error: ${e}`);
      process.exit(1);
    }
    for (const w of m.warnings) console.log(`note: ${w}`);
    const factsDir = flag("facts-dir");
    let sec: SecProvider | FileSecSource;
    if (factsDir) {
      console.log(`offline run: reading recorded company-facts files from ${factsDir}. No network, no SEC identity.`);
      sec = new FileSecSource(factsDir);
    } else {
      try {
        sec = new SecProvider({ identity: process.env.GENINVESTOR_SEC_IDENTITY ?? "" });
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    }
    const asOf = flag("as-of");
    if (asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      console.error("--as-of must be a date like 2024-06-01");
      process.exit(1);
    }
    if (asOf) console.log(`point-in-time run: only filings public on or before ${asOf} are used`);
    const store = new WorkflowStore(join(home, "runs.db"));
    const runId = flag("run", `scout-${asOf ?? new Date().toISOString().slice(0, 10)}`) as string;
    const report = await runWorkflow(scoutWorkflow(), {
      store,
      runId,
      ctx: {
        ledger, table, mandate: m.mandate, sec,
        prices: flag("prices-dir") ? new FilePriceSource(flag("prices-dir") as string) : undefined,
        ...(asOf ? { asOf, now: () => new Date(`${asOf}T12:00:00Z`) } : {}),
        writer: { provider: "template-writer" },
        skeptic: new RulesSkeptic(),
        verifier: new RulesVerifier(SCOUT_RECOMPUTE),
        displayContext: "local_user",
        outDir: flag("out", join(home, "opportunities")),
      },
    });
    for (const [id, n] of Object.entries(report.nodes)) console.log(`${n.status.padEnd(14)} ${id}${n.reason ? `  ${n.reason}` : ""}${n.reused ? "  (reused)" : ""}`);
    console.log(`run ${runId}: ${report.status}`);
    const published = report.nodes.publish?.output as { markdown: string } | undefined;
    if (published) console.log(`\n${published.markdown}`);
    process.exit(report.status === "completed" ? 0 : 3);
  }

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
    if (!claimsAudit({title:"",generatedAt:"",lines:[{text:chain.claim.text,claimIds:[id]}]},ledger,{context:"local_user",recompute:{...SCOUT_RECOMPUTE,...RECOMPUTE}}).passed) { console.error("Claim failed its evidence or rights audit."); process.exit(1); }
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
