import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { EvidenceLedger, canonicalJson, sha256 } from "./ledger.ts";
import type { Datum } from "./ledger.ts";
import { WorkflowStore, runWorkflow } from "./graph.ts";
import { loadPolicyTable, loadSchema } from "./contracts.ts";
import { validate } from "../../contracts/src/validate.ts";
import type { Schema } from "../../contracts/src/validate.ts";
import { loadMandate } from "./mandate.ts";
import { FileSecSource, SecProvider } from "./sec.ts";
import { FilePriceSource } from "./prices.ts";
import { scoutWorkflow, RulesSkeptic, SCOUT_RECOMPUTE } from "./scout.ts";
import { RulesVerifier } from "./today.ts";
import { ownershipClaims } from "./ownership.ts";
import { ModelAdapter, maskedComparison } from "./models.ts";
import type { ModelConfig } from "./models.ts";
import { claimsAudit } from "./audit.ts";
import type { BriefLine } from "./audit.ts";
export interface DailyConfig {
  mandate: string;
  factsDir?: string;
  pricesDir?: string;
  ownershipFiles?: string[];
  asOf: string;
  models?: {
    analyst: ModelConfig;
    skeptic: ModelConfig;
    verifier: ModelConfig;
  };
}
const atomic = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
/** Owner-invoked local research only. No scheduler, broker tool, approval or outward publication. */
export async function runDailyScan(
  config: DailyConfig,
  options: {
    home: string;
    baseDir?: string;
    liveSec?: boolean;
    liveModels?: boolean;
  },
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(config.asOf) ||
    !Number.isFinite(Date.parse(config.asOf)) ||
    new Date(config.asOf).toISOString().slice(0, 10) !== config.asOf ||
    config.asOf > new Date().toISOString().slice(0, 10)
  )
    throw Error("A valid non-future asOf date is required");
  if (!config.factsDir && !options.liveSec)
    throw Error(
      "Recorded factsDir is required unless the owner explicitly enables live SEC",
    );
  if (options.liveModels && !config.models)
    throw Error("Explicit model configuration is required");
  const path = (p: string) => resolve(options.baseDir ?? process.cwd(), p);
  const mandate = loadMandate(path(config.mandate));
  if (!mandate.valid || !mandate.mandate)
    throw Error("Mandate failed validation");
  const table = loadPolicyTable();
  mkdirSync(options.home, { recursive: true });
  const ledger = new EvidenceLedger(join(options.home, "ledger.db"));
  const store = new WorkflowStore();
  let runId = `daily-${config.asOf}-${sha256(canonicalJson({ config, mandate: mandate.mandate })).slice(0, 16)}`;
  try {
    const ownership: BriefLine[] = [];
    for (const file of config.ownershipFiles ?? []) {
      const data = JSON.parse(readFileSync(path(file), "utf8"));
      if (!Array.isArray(data) || data.length > 100)
        throw Error("Ownership envelope must be a bounded list");
      for (const datum of data as Datum[]) {
        if (
          validate(loadSchema("datum") as Schema, datum).length ||
          (datum.payload as any).filedAt > config.asOf ||
          (datum.payload as any).knownAsOf !== config.asOf
        )
          throw Error("Ownership availability or contract failed");
        ownership.push(...ownershipClaims(ledger, datum, "local_user"));
      }
    }
    // Fresh checkpoints per invocation: changed recorded files must never reuse yesterday's inputs.
    const report = await runWorkflow(scoutWorkflow(), {
      store,
      runId,
      ctx: {
        ledger,
        table,
        mandate: mandate.mandate,
        sec: config.factsDir
          ? new FileSecSource(path(config.factsDir))
          : new SecProvider({
              identity: process.env.GENINVESTOR_SEC_IDENTITY ?? "",
            }),
        prices: config.pricesDir
          ? new FilePriceSource(path(config.pricesDir))
          : undefined,
        writer: { provider: "template-writer" },
        skeptic: new RulesSkeptic(),
        verifier: new RulesVerifier(SCOUT_RECOMPUTE),
        displayContext: "local_user",
        asOf: config.asOf,
        now: () => new Date(`${config.asOf}T23:59:59Z`),
      },
    });
    if (report.status !== "completed")
      throw Error(
        "Daily scan failed its verification or audit; no dashboard snapshot was written",
      );
    const result = report.nodes.publish.output as {
      markdown: string;
      json: any;
    };
    const evidence = [
      ...ownership,
      ...result.json.cards.flatMap((c: any) =>
        [...c.whyPassed, ...c.wouldProveWrong, ...c.caseAgainst].filter(
          (l: BriefLine) => l.claimIds.length,
        ),
      ),
    ];
    let comparison;
    if (options.liveModels) {
      if (!evidence.length)
        throw Error("No audited evidence is available for model review");
      const m = config.models!;
      comparison = await maskedComparison({
        team: {
          analyst: new ModelAdapter(m.analyst),
          skeptic: new ModelAdapter(m.skeptic),
          verifier: new ModelAdapter(m.verifier),
        },
        ledger,
        lines: evidence,
        auditOptions: { context: "local_user", recompute: SCOUT_RECOMPUTE },
        entities: result.json.cards.map((c: any) => ({
          name: c.name,
          ticker: c.ticker,
        })),
        asOf: config.asOf,
        seed: runId,
        replayDir: join(options.home, "replays", runId),
      });
    }
    runId = `daily-${config.asOf}-${sha256(canonicalJson({ config, opportunities: result.json, ownership, replayHashes: comparison ? [comparison.masked.replayHashes, comparison.unmasked.replayHashes] : [] })).slice(0, 16)}`;
    const run = {
      runId,
      status: "audited",
      asOf: config.asOf,
      autonomy: "simulation",
      mode: "owner-invoked",
      ownership,
      models: comparison ?? { status: "not-run" },
      opportunities: result.json,
    };
    // Write only after all requested evidence/model checks succeed. Nothing is sent to a trading service.
    const stage = join(options.home, "staged", runId);
    atomic(join(stage, "run.json"), JSON.stringify(run, null, 2));
    atomic(
      join(stage, "opportunities.json"),
      JSON.stringify(result.json, null, 2),
    );
    atomic(join(stage, "opportunities.md"), result.markdown);
    atomic(
      join(stage, "manifest.json"),
      JSON.stringify({
        runId,
        jsonHash: sha256(canonicalJson(result.json)),
        markdownHash: sha256(result.markdown),
        runHash: sha256(canonicalJson(run)),
      }),
    );
    return {
      runId,
      status: "waiting_human",
      models: options.liveModels ? "comparison-recorded" : "not-run",
      reviewPath: stage,
    };
  } finally {
    ledger.close();
    store.close();
  }
}

/** Called by the owner's local CLI after inspecting the staged artifacts. Never exposed over MCP. */
export function reviewDailyScan(home: string, runId: string) {
  if (!/^daily-\d{4}-\d{2}-\d{2}-[a-f0-9]{16}$/.test(runId))
    throw Error("Invalid staged run id");
  const stage = join(home, "staged", runId);
  const data = JSON.parse(
    readFileSync(join(stage, "opportunities.json"), "utf8"),
  );
  const md = readFileSync(join(stage, "opportunities.md"), "utf8");
  const manifest = JSON.parse(
    readFileSync(join(stage, "manifest.json"), "utf8"),
  );
  const run = JSON.parse(readFileSync(join(stage, "run.json"), "utf8"));
  if (
    manifest.runId !== runId ||
    manifest.runHash !== sha256(canonicalJson(run)) ||
    manifest.jsonHash !== sha256(canonicalJson(data)) ||
    manifest.markdownHash !== sha256(md) ||
    canonicalJson(run.opportunities) !== canonicalJson(data)
  )
    throw Error("Staged artifact integrity failed");
  if (validate(loadSchema("opportunities") as Schema, data).length)
    throw Error("Staged artifact contract failed");
  const ledger = new EvidenceLedger(join(home, "ledger.db"));
  try {
    const ids = [
      ...(data.screen.claimIds ?? []),
      ...data.cards.flatMap((c: any) =>
        c.scoreClaimId ? [c.scoreClaimId] : [],
      ),
    ];
    if (!(data.screen.claimIds ?? []).length)
      throw Error("Missing screen claims");
    const lines = [
      ...run.ownership,
      ...data.cards.flatMap((c: any) => [
        ...c.whyPassed,
        ...c.wouldProveWrong,
        ...c.caseAgainst,
      ]),
      ...ids.map((id: string) => ({
        text: ledger.getClaim(id)?.text ?? "",
        claimIds: [id],
      })),
    ];
    if (
      ledger.verify().length ||
      !claimsAudit({ title: "", generatedAt: "", lines }, ledger, {
        context: "local_user",
        recompute: SCOUT_RECOMPUTE,
      }).passed
    )
      throw Error("Review evidence audit failed");
    atomic(join(home, "runs", `${runId}.json`), JSON.stringify(run, null, 2));
    atomic(join(home, "opportunities", "opportunities.md"), md);
    atomic(
      join(home, "opportunities", "opportunities.json"),
      JSON.stringify(data, null, 2),
    );
    atomic(
      join(home, "latest-run.json"),
      JSON.stringify({ runId, asOf: data.date, status: "owner-reviewed" }),
    );
    return { runId, status: "owner-reviewed" };
  } finally {
    ledger.close();
  }
}
