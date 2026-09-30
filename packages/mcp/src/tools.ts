import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ECB_SERIES,
  EcbProvider,
  EvidenceLedger,
  evaluate,
  require as requireAction,
  RulesVerifier,
  runWorkflow,
  TemplateAnalyst,
  todayWorkflow,
  WorkflowStore,
} from "../../core/src/index.ts";
import type { PolicyTable, Provider } from "../../core/src/index.ts";
import type { ToolDef } from "./server.ts";

export interface ToolContext {
  home: string;
  table: PolicyTable;
  provider?: Provider; // injectable for tests; defaults to the live ECB provider
  now?: () => Date;
}

export const INSTRUCTIONS =
  "GenInvestor turns public data into a sourced daily brief and lets you inspect the evidence behind every figure. " +
  "Information, not advice: it never recommends buying or selling, holds no custody, and cannot place orders. " +
  "Decisions that need a human (approving a thesis marked broken, anything touching real funds) are made outside this server, by design.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function open(ctx: ToolContext): EvidenceLedger {
  mkdirSync(ctx.home, { recursive: true });
  return new EvidenceLedger(join(ctx.home, "ledger.db"));
}

export function buildTools(ctx: ToolContext): ToolDef[] {
  // Every tool call passes the same gate the engine uses. If the table is ever changed so that
  // research is not allowed, the server stops answering instead of quietly carrying on.
  const gate = (verb: string) => requireAction(ctx.table, verb);

  return [
    {
      name: "check_action",
      title: "Check an action against the autonomy gate",
      description: "Ask whether an action would be allowed, needs a human, or is blocked. This only answers; it never performs the action.",
      inputSchema: {
        type: "object",
        required: ["action_type"],
        additionalProperties: false,
        properties: {
          action_type: { type: "string", minLength: 1 },
          mode: { enum: ctx.table.modes },
          uses_real_funds: { type: "boolean" },
          touches_wallet: { type: "boolean" },
          touches_banking: { type: "boolean" },
          requires_secret: { type: "boolean" },
          amount: { type: "number" },
          cap: { type: "number" },
        },
      },
      annotations: READ_ONLY,
      handler: (args) => {
        gate("research");
        const d = evaluate(ctx.table, args as never);
        return { text: `${d.verdict}: ${d.reason}`, structured: { verdict: d.verdict, reason: d.reason, requiredGate: d.requiredGate } };
      },
    },
    {
      name: "explain_claim",
      title: "Show the evidence chain behind a claim",
      description: "Given a claim id from a brief, return the claim, each link, and the source with its as-of date, retrieval time, hash and licence class.",
      inputSchema: { type: "object", required: ["claim_id"], additionalProperties: false, properties: { claim_id: { type: "string", minLength: 1 } } },
      annotations: READ_ONLY,
      handler: (args) => {
        gate("research");
        const ledger = open(ctx);
        try {
          const chain = ledger.explain(String(args.claim_id));
          if (!chain) return { text: `No claim ${String(args.claim_id)} in the ledger.`, isError: true };
          const lines = [`${chain.claim.kind.toUpperCase()}: ${chain.claim.text}`];
          for (const { link, source } of chain.sources) {
            lines.push(`- ${link.kind} ${link.fieldOrQuote}${link.value ? ` = ${link.value}` : ""}`);
            lines.push(`  source ${source?.provider} ${source?.url}; as of ${source?.asOf}; retrieved ${source?.retrievedAt}; sha256 ${source?.sha256}; licence ${source?.licenceClass}`);
          }
          return { text: lines.join("\n"), structured: chain as unknown as Record<string, unknown> };
        } finally {
          ledger.close();
        }
      },
    },
    {
      name: "verify_ledger",
      title: "Check the evidence ledger for tampering",
      description: "Re-hash every stored source and report any whose bytes no longer match.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      annotations: READ_ONLY,
      handler: () => {
        gate("research");
        const ledger = open(ctx);
        try {
          const tampered = ledger.verify();
          return { text: tampered.length === 0 ? "Ledger ok: every stored source matches its hash." : `Tampered sources: ${tampered.join(", ")}`, structured: { ok: tampered.length === 0, tampered }, isError: tampered.length > 0 };
        } finally {
          ledger.close();
        }
      },
    },
    {
      name: "get_latest_brief",
      title: "Read the most recent daily brief",
      description: "Return the last brief this server published, as markdown and as structured data. Runs nothing.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      annotations: READ_ONLY,
      handler: () => {
        gate("research");
        const md = join(ctx.home, "briefs", "brief.md");
        const js = join(ctx.home, "briefs", "brief.json");
        if (!existsSync(md) || !existsSync(js)) return { text: "No brief has been published yet. Run run_today first.", isError: true };
        return { text: readFileSync(md, "utf8"), structured: JSON.parse(readFileSync(js, "utf8")) };
      },
    },
    {
      name: "run_today",
      title: "Build today's sourced brief",
      description:
        "Fetch ECB data, compute changes, check theses, verify and audit every claim, and publish the brief locally. Reaches the public ECB API. " +
        "If a thesis is marked broken the run stops and waits for a human decision that cannot be made through this server.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async () => {
        gate("research");
        const ledger = open(ctx);
        const store = new WorkflowStore(join(ctx.home, "runs.db"));
        try {
          const now = ctx.now ?? (() => new Date());
          const runId = `today-${now().toISOString().slice(0, 10)}`;
          const report = await runWorkflow(todayWorkflow(), {
            store,
            runId,
            ctx: {
              ledger,
              table: ctx.table,
              provider: ctx.provider ?? new EcbProvider(),
              analyst: new TemplateAnalyst(),
              verifier: new RulesVerifier(),
              watchlist: Object.keys(ECB_SERIES),
              theses: [],
              displayContext: "local_user",
              outDir: join(ctx.home, "briefs"),
              now,
            },
          });
          const published = report.nodes.publish?.output as { markdown: string } | undefined;
          const nodes = Object.fromEntries(Object.entries(report.nodes).map(([k, v]) => [k, v.status + (v.reason ? `: ${v.reason}` : "")]));
          return {
            text: published?.markdown ?? `Run ${runId} ${report.status}.\n${JSON.stringify(nodes, null, 2)}`,
            structured: { runId, status: report.status, nodes },
            isError: report.status === "failed" || report.status === "blocked",
          };
        } finally {
          store.close();
          ledger.close();
        }
      },
    },
  ];
}
